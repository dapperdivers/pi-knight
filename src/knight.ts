import fs from "node:fs/promises";
import path from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { createCodingTools } from "@mariozechner/pi-coding-agent";
import type { KnightConfig } from "./config.js";
import type { SkillCatalog } from "./skills.js";
import { log } from "./logger.js";

export interface TaskResult {
  result: string;
  cost: number;
  tokens: { input: number; output: number };
  model: string;
}

/**
 * Read a config file with fallback chain:
 * 1. /data/<filename> (PVC)
 * 2. /config/<filename> (ConfigMap)
 * 3. /app/defaults/<filename> (image defaults)
 * 4. defaults/<filename> (dev fallback)
 */
async function readWithChain(filename: string): Promise<string | null> {
  const searchPaths = [
    `/data/${filename}`,
    `/config/${filename}`,
    `/app/defaults/${filename}`,
    path.resolve(import.meta.dirname ?? ".", "..", "defaults", filename),
  ];
  for (const p of searchPaths) {
    try {
      return await fs.readFile(p, "utf-8");
    } catch {
      // try next
    }
  }
  return null;
}

async function buildSystemPrompt(config: KnightConfig, skills: SkillCatalog): Promise<string> {
  const parts: string[] = [];

  const soul = await readWithChain("SOUL.md");
  if (soul) parts.push(soul);

  const identity = await readWithChain("IDENTITY.md");
  if (identity) parts.push(identity);

  const agents = await readWithChain("AGENTS.md");
  if (agents) parts.push(agents);

  const tools = await readWithChain("TOOLS.md");
  if (tools) parts.push(tools);

  if (skills.length > 0) {
    const skillList = skills
      .map((s) => `- **${s.name}** (${s.category}): ${s.description}`)
      .join("\n");
    parts.push(`# Available Skills\n\n${skillList}`);
  }

  return parts.join("\n\n---\n\n");
}

/**
 * Execute a task using the Pi SDK Agent with coding tools.
 */
export async function executeTask(
  task: string,
  config: KnightConfig,
  skills: SkillCatalog,
  signal?: AbortSignal,
): Promise<TaskResult> {
  const systemPrompt = await buildSystemPrompt(config, skills);

  // Parse model string: "provider/model-name"
  const slashIdx = config.knightModel.indexOf("/");
  const provider = slashIdx > 0 ? config.knightModel.slice(0, slashIdx) : "anthropic";
  const modelName = slashIdx > 0 ? config.knightModel.slice(slashIdx + 1) : config.knightModel;

  log.info("Executing task", { provider, model: modelName, taskLength: task.length });

  // Get the model from pi-ai
  const model = getModel(provider as any, modelName as any);

  // Create coding tools (read, write, edit, bash, grep, find, ls)
  const tools = createCodingTools(process.cwd());

  // Create agent
  const agent = new Agent();
  agent.setModel(model);
  agent.setSystemPrompt(systemPrompt);
  // Tools from pi-coding-agent implement the AgentTool interface
  agent.setTools(tools as any);

  // Track tokens and cost from events
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  let lastAssistantText = "";

  const unsub = agent.subscribe((event: AgentEvent) => {
    if (event.type === "message_end") {
      // Extract text from the completed message
      const msg = event.message as any;
      if (msg?.content) {
        const textParts = Array.isArray(msg.content)
          ? msg.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("")
          : typeof msg.content === "string"
            ? msg.content
            : "";
        if (textParts) lastAssistantText = textParts;
      }
      // Track usage
      if (msg?.usage) {
        totalInputTokens += msg.usage.inputTokens ?? msg.usage.input_tokens ?? 0;
        totalOutputTokens += msg.usage.outputTokens ?? msg.usage.output_tokens ?? 0;
        totalCost += msg.usage.cost ?? 0;
      }
    }
    if (event.type === "turn_end") {
      const msg = event.message as any;
      if (msg?.usage) {
        totalInputTokens += msg.usage.inputTokens ?? msg.usage.input_tokens ?? 0;
        totalOutputTokens += msg.usage.outputTokens ?? msg.usage.output_tokens ?? 0;
        totalCost += msg.usage.cost ?? 0;
      }
    }
  });

  try {
    await agent.prompt(task);
    await agent.waitForIdle();
  } finally {
    unsub();
  }

  // Fallback: extract from agent state messages
  if (!lastAssistantText) {
    const messages = agent.state.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i] as any;
      if (msg?.role === "assistant") {
        if (typeof msg.content === "string") {
          lastAssistantText = msg.content;
          break;
        }
        if (Array.isArray(msg.content)) {
          const text = msg.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
          if (text) {
            lastAssistantText = text;
            break;
          }
        }
      }
    }
  }

  if (!lastAssistantText) {
    lastAssistantText = "[No output from agent]";
  }

  log.info("Task completed", {
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cost: totalCost,
  });

  return {
    result: lastAssistantText,
    cost: totalCost,
    tokens: { input: totalInputTokens, output: totalOutputTokens },
    model: config.knightModel,
  };
}

import fs from "node:fs/promises";
import path from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import type { AssistantMessage, Usage } from "@mariozechner/pi-ai";
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

  function extractUsage(msg: unknown): void {
    const m = msg as AssistantMessage | undefined;
    if (!m?.usage) return;
    const u: Usage = m.usage;
    totalInputTokens += u.input ?? 0;
    totalOutputTokens += u.output ?? 0;
    totalCost += u.cost?.total ?? 0;
  }

  function extractText(msg: unknown): void {
    const m = msg as AssistantMessage | undefined;
    if (!m?.content) return;
    const parts = Array.isArray(m.content)
      ? m.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("")
      : "";
    if (parts) lastAssistantText = parts;
  }

  const unsub = agent.subscribe((event: AgentEvent) => {
    if (event.type === "message_end") {
      extractText(event.message);
      extractUsage(event.message);
    }
    if (event.type === "turn_end") {
      extractUsage(event.message);
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
      const msg = messages[i] as AssistantMessage;
      if (msg?.role === "assistant" && Array.isArray(msg.content)) {
        const text = msg.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");
        if (text) {
          lastAssistantText = text;
          // Also grab usage if we missed it from events
          if (totalInputTokens === 0 && msg.usage) {
            extractUsage(msg);
          }
          break;
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

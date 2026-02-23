import { getModel } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  type SessionStats,
} from "@mariozechner/pi-coding-agent";
import { InMemoryAuthStorageBackend, AuthStorage } from "@mariozechner/pi-coding-agent";
import { SettingsManager } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { KnightConfig } from "./config.js";
import { log } from "./logger.js";

export interface TaskResult {
  result: string;
  cost: number;
  tokens: { input: number; output: number };
  model: string;
  toolCalls: number;
}

/**
 * Execute a task using Pi SDK's AgentSession with full skill support.
 *
 * Uses createAgentSession() which provides:
 * - agentskills.io-compliant skill discovery + prompt injection
 * - Built-in coding tools (read, write, edit, bash, grep, find, ls)
 * - Session stats (tokens, cost) tracking
 * - Auto-compaction for long conversations
 * - Skill reload capability
 */
export async function executeTask(
  task: string,
  config: KnightConfig,
  signal?: AbortSignal,
): Promise<TaskResult> {
  // Parse model: "provider/model-name"
  const slashIdx = config.knightModel.indexOf("/");
  const provider = slashIdx > 0 ? config.knightModel.slice(0, slashIdx) : "anthropic";
  const modelName = slashIdx > 0 ? config.knightModel.slice(slashIdx + 1) : config.knightModel;

  log.info("Executing task", { provider, model: modelName, taskLength: task.length });

  const model = getModel(provider as any, modelName as any);

  // Create session with Pi SDK — it handles skills, tools, system prompt
  const { session } = await createAgentSession({
    model,
    cwd: "/data",              // Knight workspace (PVC)
    agentDir: "/config",       // ConfigMap personality files (SOUL.md, etc.)
    resourceLoader: new DefaultResourceLoader({
      cwd: "/data",
      agentDir: "/config",
      additionalSkillPaths: ["/skills"],  // Arsenal repo via git-sync
      noExtensions: true,
      noThemes: true,
      noPromptTemplates: true,
      systemPrompt: buildKnightPreamble(config),
    }),
    thinkingLevel: "off",
  });

  // Execute the task
  await session.prompt(task);

  // Get stats from SDK — no manual tracking needed
  const stats: SessionStats = session.getSessionStats();

  // Extract last assistant text from agent state
  const messages = session.agent.state.messages;
  let resultText = "[No output from agent]";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (msg?.role === "assistant" && Array.isArray(msg.content)) {
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
      if (text) {
        resultText = text;
        break;
      }
    }
  }

  log.info("Task completed", {
    inputTokens: stats.tokens.input,
    outputTokens: stats.tokens.output,
    cost: stats.cost,
    toolCalls: stats.toolCalls,
  });

  return {
    result: resultText,
    cost: stats.cost,
    tokens: { input: stats.tokens.input, output: stats.tokens.output },
    model: config.knightModel,
    toolCalls: stats.toolCalls,
  };
}

/**
 * Build a short preamble that identifies the knight.
 * The rest (skills, AGENTS.md, tools) is handled by Pi SDK's resource loader.
 */
function buildKnightPreamble(config: KnightConfig): string {
  return [
    `You are ${config.knightName}, a Knight of the Round Table.`,
    `You receive tasks via NATS JetStream and execute them using your tools and skills.`,
    `Your results are published back to NATS automatically.`,
    `Stay within your domain. Be thorough but concise.`,
  ].join("\n");
}

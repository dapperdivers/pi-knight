import { getModel } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  type SessionStats,
} from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { KnightConfig } from "./config.js";
import { log } from "./logger.js";
import { natsTools } from "./tools/nats.js";

export interface TaskResult {
  result: string;
  cost: number;
  tokens: { input: number; output: number };
  model: string;
  toolCalls: number;
}

// Persistent session — reused across tasks
let session: AgentSession | null = null;
let cumulativeCostBefore = 0;
let cumulativeToolCallsBefore = 0;
let cumulativeTokensBefore = { input: 0, output: 0 };

/**
 * Get or create the persistent AgentSession.
 *
 * The session persists across tasks (JSONL on PVC), giving the knight
 * memory of previous work. Pi SDK handles auto-compaction when context grows.
 */
async function getSession(config: KnightConfig): Promise<AgentSession> {
  if (session) return session;

  const slashIdx = config.knightModel.indexOf("/");
  const provider = slashIdx > 0 ? config.knightModel.slice(0, slashIdx) : "anthropic";
  const modelName = slashIdx > 0 ? config.knightModel.slice(slashIdx + 1) : config.knightModel;

  log.info("Creating persistent session", { provider, model: modelName });

  const model = getModel(provider as any, modelName as any);

  const thinkingLevel = (config.thinkingLevel ?? "off") as ThinkingLevel;

  const { session: newSession } = await createAgentSession({
    model,
    thinkingLevel,
    cwd: "/data",
    agentDir: "/config",
    customTools: natsTools,
    resourceLoader: new DefaultResourceLoader({
      cwd: "/data",
      agentDir: "/config",
      additionalSkillPaths: ["/skills"],
      noExtensions: true,
      noThemes: true,
      noPromptTemplates: true,
      systemPrompt: buildKnightPreamble(config),
    }),
  });

  session = newSession;

  // Capture baseline stats (session may have prior history from PVC)
  const stats = session.getSessionStats();
  cumulativeCostBefore = stats.cost;
  cumulativeToolCallsBefore = stats.toolCalls;
  cumulativeTokensBefore = { input: stats.tokens.input, output: stats.tokens.output };

  log.info("Persistent session created", {
    sessionId: stats.sessionId,
    priorMessages: stats.totalMessages,
    priorCost: stats.cost,
  });

  return session;
}

/**
 * Execute a task on the persistent session.
 *
 * Each task is a new prompt() on the same session — the knight
 * remembers context from previous tasks within the session lifetime.
 * Pi SDK auto-compacts when context grows too large.
 */
export async function executeTask(
  task: string,
  config: KnightConfig,
  signal?: AbortSignal,
): Promise<TaskResult> {
  const sess = await getSession(config);

  // Snapshot stats before this task
  const statsBefore = sess.getSessionStats();
  const costBefore = statsBefore.cost;
  const toolCallsBefore = statsBefore.toolCalls;
  const tokensBefore = { input: statsBefore.tokens.input, output: statsBefore.tokens.output };

  log.info("Executing task", { model: config.knightModel, taskLength: task.length });

  // Abort handling — if signal fires, abort the session
  let abortHandler: (() => void) | undefined;
  if (signal) {
    abortHandler = () => {
      log.warn("Task aborted via signal");
      sess.abort();
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    await sess.prompt(task);
  } finally {
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }

  // Diff stats to get this task's contribution
  const statsAfter = sess.getSessionStats();
  const taskCost = statsAfter.cost - costBefore;
  const taskToolCalls = statsAfter.toolCalls - toolCallsBefore;
  const taskTokens = {
    input: statsAfter.tokens.input - tokensBefore.input,
    output: statsAfter.tokens.output - tokensBefore.output,
  };

  // Extract last assistant text
  const resultText = sess.getLastAssistantText() ?? "[No output from agent]";

  log.info("Task completed", {
    inputTokens: taskTokens.input,
    outputTokens: taskTokens.output,
    cost: taskCost,
    toolCalls: taskToolCalls,
  });

  return {
    result: resultText,
    cost: taskCost,
    tokens: taskTokens,
    model: config.knightModel,
    toolCalls: taskToolCalls,
  };
}

/**
 * Build a short preamble identifying the knight.
 * Skills, AGENTS.md, personality files are handled by Pi SDK's resource loader.
 */
function buildKnightPreamble(config: KnightConfig): string {
  return `You are ${config.knightName}, a Knight of the Round Table.`;
}

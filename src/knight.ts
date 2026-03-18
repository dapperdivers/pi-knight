import { getModel } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  type SessionStats,
  compactMessages,
} from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel, AgentMessage } from "@mariozechner/pi-agent-core";
import type { KnightConfig } from "./config.js";
import { log } from "./logger.js";
import { natsTools, setKnightName, setNatsPrefix } from "./tools/nats.js";
import { subagentTools, setParentModel } from "./tools/subagent.js";
import { browserTools } from "./tools/browser.js";

export interface TaskResult {
  result: string;
  cost: number;
  tokens: { input: number; output: number };
  model: string;
  toolCalls: number;
}

// Persistent session — reused across tasks
let session: AgentSession | null = null;

/** Get the active session (or null if not yet created). Used by introspect. */
export function getActiveSession(): AgentSession | null {
  return session;
}
let cumulativeCostBefore = 0;
let cumulativeToolCallsBefore = 0;
let cumulativeTokensBefore = { input: 0, output: 0 };

// Serialize prompt() calls — Pi SDK sessions handle one prompt at a time
let promptLock: Promise<void> = Promise.resolve();

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

  setKnightName(config.knightName);
  // Derive NATS prefix from results prefix (e.g. "rt-dev.results" → "rt-dev")
  setNatsPrefix(config.natsResultsPrefix.replace(/\.results$/, ""));
  setParentModel(config.knightModel);
  let model = getModel(provider as any, modelName as any);

  // If model not found in registry, create a custom model definition.
  // This enables local/custom OpenAI-compatible endpoints (e.g. LiteLLM → Ollama).
  if (!model) {
    const baseUrl = process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || "http://localhost:4000/v1";
    log.info("Model not in registry, creating custom openai-completions model", {
      provider, model: modelName, baseUrl
    });
    model = {
      id: modelName,
      name: modelName,
      api: "openai-completions" as any,
      provider: provider,
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 8192,
    } as any;
  }

  const thinkingLevel = (config.thinkingLevel ?? "off") as ThinkingLevel;

  const { session: newSession } = await createAgentSession({
    model,
    thinkingLevel,
    sessionId: `knight-${config.knightName}`,
    cwd: "/data",
    agentDir: "/config",
    customTools: [
      ...natsTools,
      ...subagentTools,
      ...(process.env.BROWSER_ENABLED === "true" ? browserTools : []),
    ],
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

  // Set maxRetryDelayMs on the underlying agent
  session.agent.maxRetryDelayMs = config.maxRetryDelayMs;
  log.info("Retry delay cap configured", { maxRetryDelayMs: config.maxRetryDelayMs });

  // transformContext — semantic compaction when context exceeds token threshold
  const pruneThreshold = config.contextPruneTokens;
  (session.agent as any).transformContext = async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
    const totalChars = messages.reduce((sum, m) => {
      const content = (m as any).content;
      return sum + (typeof content === "string" ? content.length : JSON.stringify(content ?? "").length);
    }, 0);
    const estimatedTokens = Math.round(totalChars / 4);

    if (estimatedTokens <= pruneThreshold) return messages;

    log.info("Context compaction triggered", { estimatedTokens, threshold: pruneThreshold, messageCount: messages.length });

    // Use Pi SDK's semantic compaction (summarizes old context with cheap model)
    const compacted = await compactMessages(messages, {
      targetTokens: Math.floor(pruneThreshold * 0.7),
      model: getModel("anthropic", "claude-haiku-3-5"),
      preserveRecent: 10,
      signal,
    }).catch((err) => {
      log.warn("Compaction failed, falling back to original messages", { error: String(err) });
      return messages;
    });

    log.info("Context compaction complete", { before: messages.length, after: compacted.length });
    return compacted;
  };

  // thinkingBudgets — set custom token budgets if thinking is enabled
  if (thinkingLevel !== "off") {
    session.agent.thinkingBudgets = {
      low: config.thinkingBudgetLow,
      medium: config.thinkingBudgetMedium,
      high: config.thinkingBudgetHigh,
    };
    log.info("Thinking budgets configured", {
      level: thinkingLevel,
      budgets: session.agent.thinkingBudgets,
    });
  }

  // onPayload observability hook — log model/token metadata for each LLM call
  (session.agent as any)._onPayload = (payload: unknown, model: any) => {
    try {
      const p = payload as any;
      const tokenEstimate = JSON.stringify(p).length / 4; // rough char-to-token estimate
      log.debug("LLM payload", {
        model: model?.id ?? model?.name ?? "unknown",
        provider: model?.provider ?? "unknown",
        messageCount: Array.isArray(p?.messages) ? p.messages.length : undefined,
        estimatedTokens: Math.round(tokenEstimate),
        maxTokens: p?.max_tokens,
        thinkingBudget: p?.thinking?.budget_tokens,
      });
    } catch { /* observability must never break the agent */ }
    return undefined; // pass through unmodified
  };

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
  // Serialize — wait for any in-flight prompt to finish
  const prevLock = promptLock;
  let releaseLock: () => void;
  promptLock = new Promise((resolve) => { releaseLock = resolve; });
  await prevLock;

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
    releaseLock!();
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
    estimatedCacheTokens: Math.max(0, tokensBefore.input - taskTokens.input),
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

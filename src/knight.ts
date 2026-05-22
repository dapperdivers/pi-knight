import { rmSync, existsSync } from "node:fs";
import { getModel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  AuthStorage,
  type AgentSession,
  type SessionStats,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel, AgentMessage } from "@earendil-works/pi-agent-core";
import type { KnightConfig } from "./config.js";
import { log } from "./logger.js";
import { natsTools, setKnightName, setNatsPrefix } from "./tools/nats.js";
import { subagentTools, setParentModel } from "./tools/subagent.js";
import { browserTools } from "./tools/browser.js";
import { setupToolHooks } from "./hooks.js";
import { setupCompactionHook, updateSessionNotes } from "./memory.js";
import { getBestAssistantResult } from "./result-extraction.js";

function buildAuthStorage(): AuthStorage {
  const refreshToken = process.env.ANTHROPIC_OAUTH_REFRESH_TOKEN;
  if (refreshToken) {
    log.info("Using Anthropic OAuth (Max subscription)");
    delete process.env.ANTHROPIC_API_KEY;

    // Use file-backed storage so the SDK can persist rotated tokens across pod restarts.
    // Remove any stale lockfile left by a previous SIGKILL before creating the storage.
    const authPath = "/data/auth.json";
    const lockPath = `${authPath}.lock`;
    if (existsSync(lockPath)) {
      log.warn("Removing stale auth lockfile", { lockPath });
      rmSync(lockPath, { recursive: true, force: true });
    }

    const storage = AuthStorage.create(authPath);
    // Only seed from env var on first boot — after that the persisted (rotated) token is used.
    if (!storage.has("anthropic")) {
      log.info("Seeding OAuth token from env var (first boot)");
      storage.set("anthropic", { type: "oauth", access: "", refresh: refreshToken, expires: 0 });
    } else {
      log.info("Using persisted OAuth token from disk");
    }
    return storage;
  }
  return AuthStorage.inMemory();
}

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
    const contextWindow = parseInt(process.env.MODEL_CONTEXT_WINDOW ?? "131072", 10);
    const maxTokens = parseInt(process.env.MODEL_MAX_TOKENS ?? "16384", 10);
    log.info("Model not in registry, creating custom openai-completions model", {
      provider, model: modelName, baseUrl, contextWindow, maxTokens,
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
      contextWindow,
      maxTokens,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStrictMode: false,
        supportsStore: false,
        maxTokensField: "max_tokens",
      },
    } as any;
  }

  const thinkingLevel = (config.thinkingLevel ?? "off") as ThinkingLevel;

  // Use in-memory auth storage — avoids /data/auth.json lock deadlocks on SIGKILL.
  // If ANTHROPIC_OAUTH_REFRESH_TOKEN is set, pre-populate with OAuth credentials so
  // the SDK can use the Claude Max subscription instead of an API key.
  const { session: newSession } = await createAgentSession({
    model,
    thinkingLevel,
    cwd: "/data",
    agentDir: "/data",
    authStorage: buildAuthStorage(),
    customTools: [
      ...natsTools,
      ...subagentTools,
      ...(process.env.BROWSER_ENABLED === "true" ? browserTools : []),
    ],
    resourceLoader: new DefaultResourceLoader({
      cwd: "/data",
      agentDir: "/data",
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

  // Enable parallel tool execution — agent runs independent tool calls concurrently.
  // Matches the system prompt instruction to maximise parallel tool calls where possible.
  session.agent.toolExecution = "parallel";

  // Install tool hooks — safety guardrails, observability, metrics
  setupToolHooks(session);

  // Install custom compaction hook — knight-specific context preservation
  setupCompactionHook(session, config);

  // transformContext — prune old tool results when context exceeds token threshold
  const pruneThreshold = config.contextPruneTokens;
  (session.agent as any).transformContext = async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    const totalChars = messages.reduce((sum, m) => {
      const content = (m as any).content;
      return sum + (typeof content === "string" ? content.length : JSON.stringify(content ?? "").length);
    }, 0);
    const estimatedTokens = Math.round(totalChars / 4);

    if (estimatedTokens <= pruneThreshold) return messages;

    log.info("Context pruning triggered", { estimatedTokens, threshold: pruneThreshold, messageCount: messages.length });
    let pruned = 0;
    // Prune from oldest, skip the last few messages to preserve recency
    const result = messages.map((m, i) => {
      if (i >= messages.length - 4) return m; // keep recent messages intact
      const role = (m as any).role;
      if (role === "tool_result" || role === "tool") {
        const content = (m as any).content;
        if (typeof content === "string" && content.length > 500) {
          pruned++;
          return { ...m, content: content.slice(0, 500) + "\n[…truncated by context pruning]" } as AgentMessage;
        }
      }
      return m;
    });
    if (pruned > 0) log.info("Context pruning complete", { prunedMessages: pruned });
    return result;
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

  // onPayload observability hook — log model/token metadata for each LLM call.
  // NOTE: field is `onPayload` (no underscore). The previous `_onPayload` was a no-op.
  session.agent.onPayload = async (payload: unknown, model: any) => {
    try {
      const p = payload as any;
      // Summary log at info level — safe to always emit
      log.info("LLM request payload", {
        model: model?.id ?? model?.name ?? "unknown",
        provider: model?.provider ?? "unknown",
        messageCount: Array.isArray(p?.messages) ? p.messages.length : undefined,
        toolCount: Array.isArray(p?.tools) ? p.tools.length : 0,
        toolNames: Array.isArray(p?.tools) ? p.tools.map((t: any) => t?.function?.name ?? t?.name).filter(Boolean) : [],
        hasToolChoice: p?.tool_choice !== undefined,
        maxTokens: p?.max_tokens ?? p?.max_completion_tokens,
        stream: p?.stream,
      });
      // Full payload at debug level for diagnostics
      log.debug("LLM request payload (full)", { payload: p });
    } catch (err) {
      log.warn("onPayload hook threw", { error: String(err) });
    }
    return payload; // pass through unmodified
  };

  // Log active tool names at session create time so we can verify custom tools
  // are actually registered with the agent (not just in the tool registry).
  try {
    const activeToolNames = (session.agent.state?.tools ?? []).map((t: any) => t?.name).filter(Boolean);
    log.info("Agent active tools", {
      count: activeToolNames.length,
      names: activeToolNames,
    });
  } catch (err) {
    log.warn("Failed to introspect active tools", { error: String(err) });
  }

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

  // Extract the most recent real deliverable, not an intermediate tool-call payload.
  const resultText = getBestAssistantResult(sess) ?? "[No output from agent]";

  // Update session notes after each task (fire-and-forget)
  updateSessionNotes(config.knightName, task, resultText).catch((err) => {
    log.warn("Failed to update session notes", { error: String(err) });
  });

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
/**
 * Build the system prompt preamble for this knight.
 *
 * This is injected BEFORE AGENTS.md/SOUL.md (which the resource loader handles).
 * Keep it focused on runtime identity and behavioral guardrails that apply
 * to ALL knights regardless of their individual personality.
 *
 * Pattern: Explicit negative instructions + reasoning (from Claude Code leak analysis).
 */
function buildKnightPreamble(config: KnightConfig): string {
  return `You are ${config.knightName}, a Knight of the Round Table.
You are a specialized AI agent running as a Kubernetes pod in the Round Table fleet.
The current model is ${config.knightModel}.

<runtime_context>
Knight: ${config.knightName}
Model: ${config.knightModel}
Workspace: /data (persistent PVC — survives restarts)
Skills: /skills (read-only, operator-managed)
Vault: /vault (Derek's Obsidian vault — write only to Briefings/ and Roundtable/)
</runtime_context>

<default_to_action>
By default, implement changes rather than only suggesting them. If the task's intent is
unclear, infer the most useful likely action and proceed, using tools to discover any
missing details instead of guessing. Your text response IS the deliverable — when asked
to write a report, your response IS that report. Never describe what you would write.
</default_to_action>

<use_parallel_tool_calls>
If you intend to call multiple tools and there are no dependencies between the calls,
make all independent calls in parallel. For example, when reading 3 files, read all 3
at once. Maximize parallel tool calls where possible. However, if some calls depend on
previous results, call those sequentially. Never use placeholders or guess missing
parameters in tool calls.
</use_parallel_tool_calls>

<critical_rules>
1. Read MEMORY.md and SOUL.md at the start of each task for accumulated context.
2. Log your work to memory/YYYY-MM-DD.md after each task.
3. NEVER truncate results. If the task asks for full output, provide full output.
4. NEVER create files unless necessary for the task. Prefer editing existing files.
5. If a tool call fails, understand WHY before retrying — don't loop on the same error.
6. Prefer targeted file reads (offset/limit) over loading entire files.
7. After completing a task that involves tool use, provide a concise summary of the
   work you've done so the caller gets a clear result without needing to parse tool output.
</critical_rules>`;
}

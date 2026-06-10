/**
 * Sub-agent spawning tool for Pi SDK agent sessions.
 *
 * Allows a knight to spin up a temporary focused agent within
 * the same process — no K8s overhead, no NATS round-trip.
 * The sub-agent executes, returns its result, and gets GC'd.
 */
import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createAgentSession, DefaultResourceLoader, defineTool, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { resolveModel, createTrustedSettingsManager } from "../model.js";
import { log } from "../logger.js";
import * as metrics from "../metrics.js";

const SpawnParams = Type.Object({
  task: Type.String({ description: "Task for the sub-agent to execute" }),
  system_prompt: Type.Optional(
    Type.String({ description: "Custom system prompt focusing the sub-agent's role (default: general-purpose)" }),
  ),
  model: Type.Optional(
    Type.String({ description: "Model override as provider/model (default: same as parent knight)" }),
  ),
  thinking: Type.Optional(
    Type.String({ description: "Thinking level: off, minimal, low, medium, high (default: off)" }),
  ),
});

function textResult(text: string): AgentToolResult<void> {
  return { content: [{ type: "text", text }], details: undefined };
}

/** Parent knight's model — overwritten via setParentModel() during session init */
let parentModel: string = "openrouter/deepseek/deepseek-v3.2";

export function setParentModel(model: string): void {
  parentModel = model;
}

/** Parent knight's name — used to attribute sub-agent spend in fleet metrics */
let parentKnight = "unknown";

export function setParentKnight(name: string): void {
  parentKnight = name;
}

export const spawnSubagentTool = defineTool({
  name: "spawn_subagent",
  label: "Spawn Sub-Agent",
  description:
    "Spawn a temporary focused agent to handle a subtask. The sub-agent runs in-process (instant, no K8s overhead), executes the task with its own context, and returns the result. Use for focused research, analysis, or data extraction that benefits from a clean context window.",
  promptSnippet: "Spawn an in-process sub-agent for focused subtasks with a clean context window (no K8s overhead)",
  promptGuidelines: [
    "Use sub-agents for tasks that benefit from a clean context — focused analysis, data extraction, or research",
    "Prefer nats_request over spawn_subagent when the task matches another knight's domain expertise",
    "Sub-agents have no memory of your session — provide all necessary context in the task description",
  ],
  parameters: SpawnParams,
  async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
    const modelStr = params.model ?? parentModel;
    const thinkingLevel = (params.thinking ?? "off") as ThinkingLevel;

    const systemPrompt = params.system_prompt ?? "You are a focused sub-agent. Complete the task thoroughly and concisely.";

    log.info("Spawning sub-agent", {
      model: modelStr,
      thinking: thinkingLevel,
      taskLength: params.task.length,
    });

    const startTime = Date.now();
    let session: AgentSession | undefined;

    try {
      // Shared resolution — same model/auth handling as the parent knight.
      const { model, authStorage, modelRegistry } = resolveModel(modelStr);

      ({ session } = await createAgentSession({
        model,
        thinkingLevel,
        cwd: "/data",
        agentDir: "/data",
        authStorage,
        modelRegistry,
        // Explicitly trust the project dir (pi 0.79 project-trust gating); see model.ts.
        settingsManager: createTrustedSettingsManager("/data", "/data"),
        resourceLoader: new DefaultResourceLoader({
          cwd: "/data",
          agentDir: "/data",
          noExtensions: true,
          noThemes: true,
          noPromptTemplates: true,
          noSkills: true, // Sub-agents are focused — no skill discovery overhead
          systemPrompt,
        }),
      }));

      // Wire abort signal
      if (signal) {
        signal.addEventListener("abort", () => session?.abort(), { once: true });
      }

      await session.prompt(params.task);

      const resultText = session.getLastAssistantText() ?? "[No output from sub-agent]";
      const stats = session.getSessionStats();
      const durationMs = Date.now() - startTime;

      // Attribute sub-agent spend to the parent knight so chains aren't invisible in
      // fleet metrics. The sub-session is fresh per spawn, so its absolute stats ARE this
      // spawn's total (no diff needed). Clamp finite/non-negative — same guard as the
      // parent task accounting — to stay safe with routing/custom models.
      const finite = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);
      metrics.llmCost.labels(parentKnight, modelStr).inc(finite(stats.cost));
      metrics.tokensTotal.labels(parentKnight, "input").inc(finite(stats.tokens.input));
      metrics.tokensTotal.labels(parentKnight, "output").inc(finite(stats.tokens.output));
      metrics.tokensTotal.labels(parentKnight, "cached").inc(finite(stats.tokens.cacheRead));

      log.info("Sub-agent completed", {
        durationMs,
        cost: stats.cost,
        tokens: { input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead },
        toolCalls: stats.toolCalls,
      });

      return textResult(
        `Sub-agent result (${Math.round(durationMs / 1000)}s, $${stats.cost.toFixed(4)}, ${stats.toolCalls} tool calls):\n\n${resultText}`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Sub-agent failed", { error: msg });
      return textResult(`Sub-agent error: ${msg}`);
    } finally {
      // Dispose the ephemeral sub-session so it doesn't leak (each spawn creates a fresh
      // session). dispose() also aborts any in-flight work if we exit via error/abort.
      session?.dispose();
    }
  },
});

export const subagentTools = [spawnSubagentTool];

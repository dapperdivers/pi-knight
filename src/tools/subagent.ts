/**
 * Sub-agent spawning tool for Pi SDK agent sessions.
 *
 * Allows a knight to spin up a temporary focused agent within
 * the same process — no K8s overhead, no NATS round-trip.
 * The sub-agent executes, returns its result, and gets GC'd.
 */
import { Type } from "@sinclair/typebox";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { createAgentSession, DefaultResourceLoader, AuthStorage, defineTool } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { log } from "../logger.js";

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

/** Parent knight's model — set during init */
let parentModel: string = "anthropic/claude-sonnet-4-5";

export function setParentModel(model: string): void {
  parentModel = model;
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
    const slashIdx = modelStr.indexOf("/");
    const provider = slashIdx > 0 ? modelStr.slice(0, slashIdx) : "anthropic";
    const modelName = slashIdx > 0 ? modelStr.slice(slashIdx + 1) : modelStr;
    const thinkingLevel = (params.thinking ?? "off") as ThinkingLevel;

    const systemPrompt = params.system_prompt ?? "You are a focused sub-agent. Complete the task thoroughly and concisely.";

    log.info("Spawning sub-agent", {
      model: modelStr,
      thinking: thinkingLevel,
      taskLength: params.task.length,
    });

    const startTime = Date.now();

    try {
      let model = getModel(provider as any, modelName as any);

      // Same fallback as the parent knight — proxy models aren't in the registry
      if (!model) {
        const baseUrl = process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || "http://localhost:4000/v1";
        model = {
          id: modelName,
          name: modelName,
          api: "openai-completions" as any,
          provider: provider,
          baseUrl,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: parseInt(process.env.MODEL_CONTEXT_WINDOW ?? "131072", 10),
          maxTokens: parseInt(process.env.MODEL_MAX_TOKENS ?? "16384", 10),
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsStrictMode: false,
            supportsStore: false,
            maxTokensField: "max_tokens",
          },
        } as any;
      }

      const { session } = await createAgentSession({
        model,
        thinkingLevel,
        cwd: "/data",
        authStorage: AuthStorage.inMemory(),
        resourceLoader: new DefaultResourceLoader({
          cwd: "/data",
          noExtensions: true,
          noThemes: true,
          noPromptTemplates: true,
          noSkills: true, // Sub-agents are focused — no skill discovery overhead
          systemPrompt,
        }),
      });

      // Wire abort signal
      if (signal) {
        signal.addEventListener("abort", () => session.abort(), { once: true });
      }

      await session.prompt(params.task);

      const resultText = session.getLastAssistantText() ?? "[No output from sub-agent]";
      const stats = session.getSessionStats();
      const durationMs = Date.now() - startTime;

      log.info("Sub-agent completed", {
        durationMs,
        cost: stats.cost,
        tokens: { input: stats.tokens.input, output: stats.tokens.output },
        toolCalls: stats.toolCalls,
      });

      return textResult(
        `Sub-agent result (${Math.round(durationMs / 1000)}s, $${stats.cost.toFixed(4)}, ${stats.toolCalls} tool calls):\n\n${resultText}`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Sub-agent failed", { error: msg });
      return textResult(`Sub-agent error: ${msg}`);
    }
  },
});

export const subagentTools = [spawnSubagentTool];

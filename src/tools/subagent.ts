/**
 * Sub-agent spawning tool for Pi SDK agent sessions.
 *
 * Allows a knight to spin up a temporary focused agent within
 * the same process — no K8s overhead, no NATS round-trip.
 * The sub-agent executes, returns its result, and gets GC'd.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { createAgentSession, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";
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

export const spawnSubagentTool: ToolDefinition = {
  name: "spawn_subagent",
  label: "Spawn Sub-Agent",
  description:
    "Spawn a temporary focused agent to handle a subtask. The sub-agent runs in-process (instant, no K8s overhead), executes the task with its own context, and returns the result. Use for focused research, analysis, or data extraction that benefits from a clean context window.",
  parameters: SpawnParams,
  async execute(_toolCallId, params: Static<typeof SpawnParams>, signal?: AbortSignal) {
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
      const model = getModel(provider as any, modelName as any);

      const { session } = await createAgentSession({
        model,
        thinkingLevel,
        cwd: "/data",
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
};

export const subagentTools: ToolDefinition[] = [spawnSubagentTool];

/**
 * NATS custom tools for Pi SDK agent sessions.
 *
 * Provides native tool-loop integration for knight-to-knight
 * communication over NATS JetStream. No shell scripts needed.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getJetStream, getConnection, StringCodec } from "../nats.js";
import { log } from "../logger.js";

const sc = StringCodec();

// Knight identity — set once at startup for self-echo prevention
let _knightName = "unknown";
export function setKnightName(name: string): void { _knightName = name; }

// --- Parameter Schemas ---

const PublishParams = Type.Object({
  subject: Type.String({ description: "NATS subject to publish to (e.g. fleet-a.tasks.security.my-task-id)" }),
  message: Type.String({ description: "Message payload (string or JSON)" }),
});

const RequestParams = Type.Object({
  knight: Type.String({ description: "Target knight name" }),
  domain: Type.String({ description: "Task domain (e.g. finance, security, research)" }),
  task: Type.String({ description: "Task description for the target knight" }),
  timeout_ms: Type.Optional(Type.Number({ description: "Timeout in ms (default: 600000 = 10 min)" })),
});

const SpawnSubagentParams = Type.Object({
  task: Type.String({ description: "Task for the sub-agent to execute" }),
  system_prompt: Type.Optional(Type.String({ description: "Custom system prompt for the sub-agent (default: minimal)" })),
  model: Type.Optional(Type.String({ description: "Model override as provider/model (default: same as parent)" })),
});

// --- Tool Implementations ---

function textResult(text: string): AgentToolResult<void> {
  return { content: [{ type: "text", text }], details: undefined };
}

/**
 * nats_publish — Fire-and-forget message to any NATS subject.
 */
export const natsPublishTool: ToolDefinition = {
  name: "nats_publish",
  label: "NATS Publish",
  description: "Publish a message to a NATS subject (fire-and-forget). Use for broadcasting events, sending results, or out-of-band communication.",
  parameters: PublishParams,
  async execute(_toolCallId, params: Static<typeof PublishParams>) {
    const js = getJetStream();
    if (!js) return textResult("Error: NATS not connected");

    if (!params.message || params.message.trim().length === 0) {
      log.warn("nats_publish: empty message rejected", { subject: params.subject });
      return textResult("Error: Cannot publish empty message. Provide a non-empty message payload.");
    }

    try {
      await js.publish(params.subject, sc.encode(params.message));
      log.info("nats_publish tool", { subject: params.subject, size: params.message.length });
      return textResult(`Published to ${params.subject} (${params.message.length} bytes)`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("nats_publish failed", { subject: params.subject, error: msg });
      return textResult(`Error publishing to ${params.subject}: ${msg}`);
    }
  },
};

/**
 * nats_request — Send a task to another knight and wait for their response.
 *
 * Flow:
 * 1. Generate unique task ID
 * 2. Subscribe to result subject for that task ID
 * 3. Publish task to target knight's domain subject
 * 4. Wait for result (up to timeout)
 * 5. Return the result text to the calling agent's tool loop
 */
export const natsRequestTool: ToolDefinition = {
  name: "nats_request",
  label: "NATS Request",
  description: "Send a task to another knight and wait for their response. Use for cross-knight collaboration — ask another knight a question or delegate a subtask, then continue with their answer.",
  parameters: RequestParams,
  async execute(_toolCallId, params: Static<typeof RequestParams>, signal?: AbortSignal) {
    const js = getJetStream();
    const nc = getConnection();
    if (!js || !nc) return textResult("Error: NATS not connected");

    if (!params.task || params.task.trim().length === 0) {
      log.warn("nats_request: empty task rejected", { knight: params.knight, domain: params.domain });
      return textResult("Error: Cannot send empty task. Provide a non-empty task description.");
    }

    const timeoutMs = params.timeout_ms ?? 600_000; // 10 min default
    const taskId = `${params.knight}-xreq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const taskSubject = `fleet-a.tasks.${params.domain}.${taskId}`;
    const resultSubject = `fleet-a.results.${taskId}`;

    log.info("nats_request: dispatching", {
      knight: params.knight,
      domain: params.domain,
      taskId,
      timeoutMs,
    });

    try {
      // Subscribe to result subject BEFORE publishing the task
      const sub = nc.subscribe(resultSubject, { max: 1, timeout: timeoutMs });

      // Publish the task
      const payload = JSON.stringify({
        task: params.task,
        task_id: taskId,
        domain: params.domain,
        from: _knightName.toLowerCase(),
        dispatched_by: _knightName,
        timestamp: new Date().toISOString(),
        metadata: { timeout_ms: timeoutMs },
      });
      await js.publish(taskSubject, sc.encode(payload));
      log.info("nats_request: task published", { taskId, subject: taskSubject });

      // Wait for result
      for await (const msg of sub) {
        const raw = sc.decode(msg.data);
        try {
          const result = JSON.parse(raw);
          const success = result.success ?? true;
          const text = result.result ?? raw;
          const cost = result.cost ?? 0;
          const duration = result.duration_ms ?? 0;

          log.info("nats_request: response received", {
            taskId,
            success,
            cost,
            durationMs: duration,
          });

          if (success) {
            return textResult(
              `Response from ${params.knight} (${Math.round(duration / 1000)}s, $${cost.toFixed(4)}):\n\n${text}`,
            );
          } else {
            return textResult(`${params.knight} reported failure: ${text}`);
          }
        } catch {
          return textResult(`Raw response from ${params.knight}: ${raw}`);
        }
      }

      // Sub exhausted without message = timeout
      return textResult(`Timeout: ${params.knight} did not respond within ${Math.round(timeoutMs / 1000)}s`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (signal?.aborted) {
        return textResult(`Request to ${params.knight} was cancelled`);
      }
      log.error("nats_request failed", { taskId, error: msg });
      return textResult(`Error requesting from ${params.knight}: ${msg}`);
    }
  },
};

/**
 * All NATS tools for registration with Pi SDK.
 */
export const natsTools: ToolDefinition[] = [natsPublishTool, natsRequestTool];

/**
 * NATS communication tools for Pi SDK agent sessions.
 *
 * Provides native tool-loop integration for knight-to-knight
 * communication over NATS JetStream. These tools are the primary
 * mechanism for cross-knight collaboration — no shell scripts or
 * external skills needed.
 *
 * Table-aware: all subjects use the knight's own NATS prefix,
 * derived from NATS_RESULTS_PREFIX at startup.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition, ExtensionContext, AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getJetStream, getConnection, StringCodec } from "../nats.js";
import { log } from "../logger.js";

const sc = StringCodec();

// Knight identity — set once at startup for self-echo prevention
let _knightName = "unknown";
export function setKnightName(name: string): void { _knightName = name; }

// NATS prefix — derived from config at startup (e.g. "fleet-a" or "rt-dev")
let _natsPrefix = "fleet-a";
export function setNatsPrefix(prefix: string): void { _natsPrefix = prefix; }

// --- Parameter Schemas ---

const PublishParams = Type.Object({
  subject: Type.String({ description: "Full NATS subject to publish to" }),
  message: Type.String({ description: "Message payload (string or JSON)" }),
});

const RequestParams = Type.Object({
  knight: Type.String({ description: "Target knight name (e.g. 'galahad', 'rt-operator')" }),
  domain: Type.String({ description: "Task domain matching the target knight's NATS filter (e.g. 'security', 'operator', 'frontend')" }),
  task: Type.String({ description: "Clear, self-contained task description — the target knight has NO context about your current work" }),
  timeout_ms: Type.Optional(Type.Number({ description: "Timeout in ms (default: 600000 = 10 min). Increase for complex tasks." })),
});

// --- Helpers ---

function textResult(text: string): AgentToolResult<void> {
  return { content: [{ type: "text", text }], details: undefined };
}

/**
 * nats_publish — Fire-and-forget message to any NATS subject.
 *
 * Your normal task results are published automatically by the runtime.
 * Only use this for OUT-OF-BAND messaging: alerts, reports, broadcasts.
 */
export const natsPublishTool: ToolDefinition = {
  name: "nats_publish",
  label: "NATS Publish",
  description: [
    "Publish a fire-and-forget message to a NATS subject.",
    "Your task results are published AUTOMATICALLY — do NOT use this for normal task responses.",
    "Use for: alerts, reports, broadcasts, or out-of-band messages.",
  ].join(" "),
  promptSnippet: [
    `Your NATS table prefix is dynamically set at startup (current: check your SUBSCRIBE_TOPICS).`,
    `Subject format: <your-prefix>.alerts.<type>, <your-prefix>.reports.<type>, etc.`,
    `NEVER publish empty messages. NEVER use this for task results (the runtime handles that).`,
  ].join("\n"),
  promptGuidelines: [
    "Only use for out-of-band messaging — your task result is auto-published by the runtime",
    "Use your table's prefix in subjects (visible in your startup logs)",
    "Never publish empty messages",
  ],
  parameters: PublishParams,
  async execute(_toolCallId: string, params: Static<typeof PublishParams>, _signal: AbortSignal | undefined, _onUpdate: AgentToolUpdateCallback<void> | undefined, _ctx: ExtensionContext) {
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
 * This is the primary mechanism for cross-knight collaboration. It:
 * 1. Generates a unique task ID
 * 2. Subscribes to the result subject for that task
 * 3. Publishes the task to the target knight's domain subject
 * 4. Blocks until the target responds (or timeout)
 * 5. Returns the result text into your tool loop
 *
 * IMPORTANT: Only request knights within YOUR OWN table. Cross-table
 * requests will timeout because subjects don't cross table boundaries.
 */
export const natsRequestTool: ToolDefinition = {
  name: "nats_request",
  label: "Knight Request",
  description: [
    "Send a task to another knight in your table and wait for their response.",
    "Use for cross-knight collaboration: ask a specialist for help, then continue with their answer.",
    "ONLY works with knights in YOUR table — cross-table requests will timeout.",
  ].join(" "),
  promptSnippet: [
    `## Knight-to-Knight Communication`,
    ``,
    `Use nats_request to ask another knight for help. The request is routed`,
    `through your table's NATS streams automatically.`,
    ``,
    `### Rules`,
    `- **Stay in your table**: only request knights that share your NATS prefix.`,
    `  Cross-table requests WILL timeout (different streams).`,
    `- **Be specific**: write a clear, complete task — the target has NO context.`,
    `- **Max depth 1**: include "Do not delegate to other knights" in your task.`,
    `- **Cost-aware**: each request costs tokens. Only ask when genuinely needed.`,
    ``,
    `### Usage`,
    `\`\`\``,
    `nats_request(`,
    `  knight: "galahad",`,
    `  domain: "security",`,
    `  task: "Check if CVE-2026-1234 affects any images in the roundtable namespace. Do not delegate to other knights."`,
    `)`,
    `\`\`\``,
    ``,
    `If you need a knight from a DIFFERENT table, say so in your task output`,
    `and let the orchestrator (Tim or a chain) handle cross-table coordination.`,
  ].join("\n"),
  promptGuidelines: [
    "Only request knights within your own table — cross-table requests timeout",
    "Write clear, self-contained task descriptions with full context",
    "Include 'Do not delegate to other knights' to prevent request chains",
    "Default timeout is 10 minutes — increase for complex tasks",
    "Check the target knight's domain matches their NATS filter subject",
  ],
  parameters: RequestParams,
  async execute(_toolCallId: string, params: Static<typeof RequestParams>, signal: AbortSignal | undefined, _onUpdate: AgentToolUpdateCallback<void> | undefined, _ctx: ExtensionContext) {
    const js = getJetStream();
    const nc = getConnection();
    if (!js || !nc) return textResult("Error: NATS not connected");

    if (!params.task || params.task.trim().length === 0) {
      log.warn("nats_request: empty task rejected", { knight: params.knight, domain: params.domain });
      return textResult("Error: Cannot send empty task. Provide a non-empty task description.");
    }

    const timeoutMs = params.timeout_ms ?? 600_000; // 10 min default
    const taskId = `${params.knight}-xreq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const taskSubject = `${_natsPrefix}.tasks.${params.domain}.${taskId}`;
    const resultSubject = `${_natsPrefix}.results.${taskId}`;

    log.info("nats_request: dispatching", {
      knight: params.knight,
      domain: params.domain,
      taskId,
      timeoutMs,
      prefix: _natsPrefix,
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
        metadata: { timeout_ms: timeoutMs, table_prefix: _natsPrefix },
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

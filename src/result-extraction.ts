import type { AgentSession } from "@earendil-works/pi-coding-agent";

export const NON_DELIVERABLE_PATTERNS = [
  /^\s*\{\s*"(?:type|name)"\s*:\s*"function"/s,
  /^\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:/s,
  /^\s*\{\s*"arguments"\s*:\s*\{/s,
  /"tool_calls"\s*:/s,
  /"function_call"\s*:/s,
  /assistant to=/i,
];

export function extractTextFromAssistantContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => ((part as { text?: string }).text ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function isDeliverableAssistantText(text: string): boolean {
  if (!text) return false;
  return !NON_DELIVERABLE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Describe why a session ended without a deliverable. The Pi agent loop never throws on
 * LLM failures — a stream error or abort ends the loop silently, recorded only as
 * stopReason "error"/"aborted" (plus errorMessage) on the final assistant message. If we
 * don't look at those, every API failure, rate limit, and timeout gets reported as the
 * generic "no deliverable output", which sends whoever is debugging after the wrong bug.
 */
export function describeSessionFailure(
  sess: AgentSession,
  taskAborted: boolean,
): string | undefined {
  const messages = (sess as AgentSession & { messages?: Array<{ role?: string; stopReason?: string; errorMessage?: string }> }).messages;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role !== "assistant") continue;
      if (msg.stopReason === "error") {
        return `LLM call failed: ${msg.errorMessage ?? "unknown provider error"}`;
      }
      if (msg.stopReason === "aborted") {
        return taskAborted
          ? "Task aborted before producing output (task timeout)"
          : "Task aborted before producing output";
      }
      break; // last assistant message is a normal stop — fall through to generic
    }
  }
  if (taskAborted) return "Task aborted before producing output (task timeout)";
  return undefined;
}

/**
 * Map an extracted deliverable (or undefined) to a task outcome. When the agent yields
 * nothing deliverable, the outcome is an explicit failure with an error message — never a
 * sentinel string published as a successful result. (#31) A specific failure reason
 * (LLM error, abort/timeout) takes precedence over the generic no-output message so the
 * real cause is never masked.
 */
export function resolveTaskOutcome(
  deliverable: string | undefined,
  failureReason?: string,
): {
  result: string;
  success: boolean;
  error?: string;
} {
  if (deliverable != null) return { result: deliverable, success: true };
  const error = failureReason ?? "Agent produced no deliverable output";
  return { result: error, success: false, error };
}

/**
 * Compact shape of the session's trailing messages for failure logs: role, stopReason,
 * and content part-type counts (never content itself). Enough to tell "model emitted only
 * tool calls" from "thinking-only reply" from "stream died" without dumping transcripts.
 */
export function summarizeSessionTail(sess: AgentSession, limit = 6): Array<Record<string, unknown>> {
  const messages = (sess as unknown as { messages?: Array<{ role?: string; content?: unknown; stopReason?: string; errorMessage?: string }> }).messages;
  if (!Array.isArray(messages)) return [];
  return messages.slice(-limit).map((msg) => {
    const parts: Record<string, number> = {};
    if (Array.isArray(msg?.content)) {
      for (const part of msg.content) {
        const type = (part as { type?: string })?.type ?? "unknown";
        parts[type] = (parts[type] ?? 0) + 1;
      }
    } else if (typeof msg?.content === "string") {
      parts["string"] = msg.content.length;
    }
    return {
      role: msg?.role,
      stopReason: msg?.stopReason,
      ...(msg?.errorMessage ? { errorMessage: msg.errorMessage } : {}),
      parts,
    };
  });
}

export function getBestAssistantResult(sess: AgentSession): string | undefined {
  const messages = (sess as AgentSession & { messages?: Array<{ role?: string; content?: unknown; stopReason?: string }> }).messages;
  if (!Array.isArray(messages)) {
    const fallback = sess.getLastAssistantText();
    return fallback && isDeliverableAssistantText(fallback) ? fallback : undefined;
  }

  let suspiciousFallback: string | undefined;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason === "aborted" && extractTextFromAssistantContent(msg.content).length === 0) continue;

    const text = extractTextFromAssistantContent(msg.content);
    if (!text) continue;
    if (isDeliverableAssistantText(text)) return text;
    if (!suspiciousFallback) suspiciousFallback = text;
  }

  return suspiciousFallback;
}

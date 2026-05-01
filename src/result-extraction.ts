import type { AgentSession } from "@mariozechner/pi-coding-agent";

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

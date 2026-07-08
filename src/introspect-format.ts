// Pure formatting helpers that turn raw pi-ai session entries into the compact
// items the dashboard's Session Explorer renders. Kept side-effect free (no
// NATS/knight imports) so they can be unit-tested in isolation.
//
// Data model (from @earendil-works/pi-ai). A session entry of type "message"
// carries `message: UserMessage | AssistantMessage | ToolResultMessage`:
//   - UserMessage:       role "user",       content: string | (TextContent | ImageContent)[]
//   - AssistantMessage:  role "assistant",  content: (TextContent | ThinkingContent | ToolCall)[], usage: Usage
//   - ToolResultMessage: role "toolResult", toolName, content: (TextContent | ImageContent)[], isError
// where TextContent = { type: "text", text }, ToolCall = { type: "toolCall", id, name, arguments },
// and Usage = { input, output, cost: { total, ... } }.

// Extract a short text preview from any pi-ai message content: a raw string, or
// an array of content blocks (we keep the `text` blocks). Tool arguments and
// tool-result payloads are surfaced separately as their own fields.
export function previewText(content: unknown, max = 500): string {
  if (typeof content === "string") return content.slice(0, max);
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: "text"; text: string } =>
          !!b && typeof b === "object" && (b as any).type === "text" && typeof (b as any).text === "string",
      )
      .map((b) => b.text)
      .join("\n")
      .slice(0, max);
  }
  return "";
}

// Map one session entry to its display item(s). A message may expand to more
// than one item: an assistant message yields the assistant entry plus a
// tool_use entry per tool call.
export function recentItemsForEntry(entry: any): Record<string, unknown>[] {
  const base: Record<string, unknown> = {
    id: entry.id,
    parentId: entry.parentId,
    type: entry.type,
    timestamp: entry.timestamp,
  };

  if (entry.type !== "message" || !entry.message) {
    return [base];
  }

  const msg = entry.message;
  base.role = msg.role;

  if (msg.role === "toolResult") {
    // A tool result is its own message in pi-ai (role "toolResult"), with the
    // returned content in `content` and the tool in `toolName`. Present it as a
    // tool_result entry so the timeline + Tools view show what came back.
    base.type = "tool_result";
    base.toolName = msg.toolName ?? null;
    const out = previewText(msg.content);
    base.output = out;
    base.text = msg.isError ? `⚠ ${out}` : out;
    return [base];
  }

  if (msg.role === "user") {
    base.text = previewText(msg.content);
    return [base];
  }

  if (msg.role === "assistant") {
    // AssistantMessage.content: (TextContent | ThinkingContent | ToolCall)[].
    // Tool calls are `type: "toolCall"` with `name`/`arguments`.
    const textParts: string[] = [];
    const toolEntries: Record<string, unknown>[] = [];
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        } else if (block.type === "toolCall") {
          toolEntries.push({
            id: `${entry.id}-tc-${block.id ?? toolEntries.length}`,
            parentId: entry.parentId,
            type: "tool_use",
            timestamp: entry.timestamp,
            role: "assistant",
            toolName: block.name,
            input: JSON.stringify(block.arguments ?? {}).slice(0, 500),
          });
        }
      }
    }
    if (textParts.length > 0) base.text = textParts.join("\n").slice(0, 500);

    // pi-ai Usage: token counts under input/output, cost under cost.total.
    const u = msg.usage;
    if (u && typeof u === "object") {
      base.tokens = { input: u.input ?? 0, output: u.output ?? 0 };
      if (u.cost && typeof u.cost.total === "number") base.cost = u.cost.total;
    }

    return [base, ...toolEntries];
  }

  // Unknown/custom role — still surface any text we can find.
  base.text = previewText(msg.content);
  return [base];
}

// One-line summary for the tree view.
export function summarizeEntry(entry: any): string {
  if (entry.type !== "message" || !entry.message) return entry.type;
  const msg = entry.message;
  if (msg.role === "toolResult") {
    const tool = msg.toolName ? `${msg.toolName} → ` : "toolResult: ";
    return `${tool}${previewText(msg.content, 100)}`;
  }
  if (msg.role === "assistant") {
    const text = previewText(msg.content, 100);
    const tools = Array.isArray(msg.content)
      ? msg.content.filter((b: any) => b?.type === "toolCall").map((b: any) => b.name)
      : [];
    return text ? `assistant: ${text}` : tools.length ? `assistant → ${tools.join(", ")}` : "assistant";
  }
  return `${msg.role}: ${previewText(msg.content, 100)}`;
}

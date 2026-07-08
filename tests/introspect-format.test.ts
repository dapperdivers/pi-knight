import test from "node:test";
import assert from "node:assert/strict";
import { previewText, recentItemsForEntry, summarizeEntry } from "../src/introspect-format.ts";

// Shapes below mirror @earendil-works/pi-ai 0.79.1 exactly (verified against a
// live agravain session): assistant tool calls are `type: "toolCall"` blocks;
// tool results are their own `role: "toolResult"` messages; usage lives under
// `usage.input/output` and `usage.cost.total`.

const ts = "2026-07-08T06:05:35Z";

function entry(id: string, message: unknown) {
  return { id, parentId: null, type: "message", timestamp: ts, message };
}

test("assistant text message surfaces its text and real token/cost fields", () => {
  const items = recentItemsForEntry(
    entry("a1", {
      role: "assistant",
      content: [{ type: "text", text: "Let me research current events." }],
      usage: { input: 1200, output: 340, cost: { total: 0.0123 } },
    }),
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "message");
  assert.equal(items[0].text, "Let me research current events.");
  assert.deepEqual(items[0].tokens, { input: 1200, output: 340 });
  assert.equal(items[0].cost, 0.0123);
});

test("assistant tool-call message expands into tool_use entries with args", () => {
  const items = recentItemsForEntry(
    entry("a2", {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc_1", name: "write_file", arguments: { path: "/vault/x.json", bytes: 1654 } },
      ],
      usage: { input: 50, output: 10, cost: { total: 0.001 } },
    }),
  );
  assert.equal(items.length, 2, "assistant shell + one tool_use");
  const tool = items[1];
  assert.equal(tool.type, "tool_use");
  assert.equal(tool.toolName, "write_file");
  assert.equal(tool.input, JSON.stringify({ path: "/vault/x.json", bytes: 1654 }));
  assert.equal(tool.id, "a2-tc-tc_1");
});

test("toolResult message becomes a tool_result entry with the returned content", () => {
  const items = recentItemsForEntry(
    entry("t1", {
      role: "toolResult",
      toolName: "write_file",
      isError: false,
      content: [{ type: "text", text: "Successfully wrote 1654 bytes to /vault/Briefings/Ledger/intel.json" }],
    }),
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "tool_result");
  assert.equal(items[0].toolName, "write_file");
  assert.equal(items[0].output, "Successfully wrote 1654 bytes to /vault/Briefings/Ledger/intel.json");
  assert.equal(items[0].text, "Successfully wrote 1654 bytes to /vault/Briefings/Ledger/intel.json");
});

test("errored tool result is flagged in the preview text", () => {
  const [item] = recentItemsForEntry(
    entry("t2", { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "command not found" }] }),
  );
  assert.equal(item.text, "⚠ command not found");
});

test("user message string content is surfaced", () => {
  const [item] = recentItemsForEntry(entry("u1", { role: "user", content: "Generate today's intelligence digest." }));
  assert.equal(item.role, "user");
  assert.equal(item.text, "Generate today's intelligence digest.");
});

test("non-message entries pass through untouched", () => {
  const items = recentItemsForEntry({ id: "m1", parentId: null, type: "model_change", timestamp: ts, provider: "anthropic", modelId: "claude-opus-4-8" });
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "model_change");
  assert.equal(items[0].text, undefined);
});

test("previewText keeps only text blocks and clamps length", () => {
  assert.equal(previewText([{ type: "text", text: "hello" }, { type: "toolCall", name: "x" }]), "hello");
  assert.equal(previewText("x".repeat(600)).length, 500);
  assert.equal(previewText(undefined), "");
});

test("summarizeEntry labels tool calls and results by tool name", () => {
  assert.equal(
    summarizeEntry(entry("t", { role: "toolResult", toolName: "list_dir", content: [{ type: "text", text: "-rw-r--r-- intel.json" }] })),
    "list_dir → -rw-r--r-- intel.json",
  );
  assert.equal(
    summarizeEntry(entry("a", { role: "assistant", content: [{ type: "toolCall", name: "search_web", arguments: {} }] })),
    "assistant → search_web",
  );
  assert.equal(
    summarizeEntry(entry("a", { role: "assistant", content: [{ type: "text", text: "thinking out loud" }] })),
    "assistant: thinking out loud",
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  extractTextFromAssistantContent,
  getBestAssistantResult,
  isDeliverableAssistantText,
  resolveTaskOutcome,
} from "../src/result-extraction.ts";

type MockMessage = {
  role?: string;
  content?: unknown;
  stopReason?: string;
};

type MockSession = {
  messages?: MockMessage[];
  getLastAssistantText(): string | undefined;
};

function session(messages?: MockMessage[], fallback?: string): MockSession {
  return {
    messages,
    getLastAssistantText: () => fallback,
  };
}

test("extractTextFromAssistantContent joins text segments and ignores non-text parts", () => {
  const text = extractTextFromAssistantContent([
    { type: "text", text: "First" },
    { type: "image", url: "noop" },
    { type: "text", text: "Second" },
  ]);

  assert.equal(text, "First\nSecond");
});

test("isDeliverableAssistantText rejects function-call payloads and tool routing artifacts", () => {
  assert.equal(isDeliverableAssistantText('{"name":"bash","arguments":{"command":"ls"}}'), false);
  assert.equal(isDeliverableAssistantText('assistant to=functions.read {"path":"foo"}'), false);
  assert.equal(isDeliverableAssistantText("## Real answer\nEverything looks good."), true);
});

test("getBestAssistantResult prefers the latest deliverable over trailing tool-call JSON", () => {
  const result = getBestAssistantResult(
    session([
      { role: "assistant", content: "Final answer for the user" },
      {
        role: "assistant",
        content: '{"name":"read","arguments":{"path":"/tmp/file"}}',
      },
    ]) as any,
  );

  assert.equal(result, "Final answer for the user");
});

test("getBestAssistantResult skips aborted empty assistant messages", () => {
  const result = getBestAssistantResult(
    session([
      { role: "assistant", content: "Useful answer" },
      { role: "assistant", content: [], stopReason: "aborted" },
    ]) as any,
  );

  assert.equal(result, "Useful answer");
});

test("getBestAssistantResult falls back to suspicious payload when nothing better exists", () => {
  const payload = '{"tool_calls":[{"id":"call_1"}]}';
  const result = getBestAssistantResult(
    session([
      { role: "assistant", content: payload },
    ]) as any,
  );

  assert.equal(result, payload);
});

test("getBestAssistantResult uses getLastAssistantText when messages are unavailable", () => {
  assert.equal(getBestAssistantResult(session(undefined, "Ship it") as any), "Ship it");
  assert.equal(
    getBestAssistantResult(session(undefined, 'assistant to=functions.read {"path":"foo"}') as any),
    undefined,
  );
});

test("resolveTaskOutcome maps a real deliverable to a successful outcome", () => {
  assert.deepEqual(resolveTaskOutcome("Here is the briefing."), {
    result: "Here is the briefing.",
    success: true,
  });
});

test("resolveTaskOutcome maps no deliverable to an explicit failure, not a sentinel success (#31)", () => {
  const outcome = resolveTaskOutcome(undefined);
  assert.equal(outcome.success, false);
  assert.equal(outcome.error, "Agent produced no deliverable output");
  assert.equal(outcome.result, "Agent produced no deliverable output");
});

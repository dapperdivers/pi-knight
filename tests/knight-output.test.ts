import test from "node:test";
import assert from "node:assert/strict";
import {
  describeSessionFailure,
  extractTextFromAssistantContent,
  getBestAssistantResult,
  isDeliverableAssistantText,
  resolveTaskOutcome,
  summarizeSessionTail,
} from "../src/result-extraction.ts";

type MockMessage = {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
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

test("resolveTaskOutcome prefers a specific failure reason over the generic message", () => {
  const outcome = resolveTaskOutcome(undefined, "LLM call failed: 429 rate limited");
  assert.equal(outcome.success, false);
  assert.equal(outcome.error, "LLM call failed: 429 rate limited");
  assert.equal(outcome.result, "LLM call failed: 429 rate limited");
});

test("resolveTaskOutcome ignores the failure reason when a deliverable exists", () => {
  const outcome = resolveTaskOutcome("Real answer", "LLM call failed: should not appear");
  assert.deepEqual(outcome, { result: "Real answer", success: true });
});

test("describeSessionFailure surfaces a silent LLM stream error with its provider message", () => {
  const reason = describeSessionFailure(
    session([
      { role: "user", content: "do the thing" },
      { role: "assistant", content: [], stopReason: "error", errorMessage: "402 insufficient credits" },
    ]) as any,
    false,
  );
  assert.equal(reason, "LLM call failed: 402 insufficient credits");
});

test("describeSessionFailure reports an abort as a timeout when the task signal fired", () => {
  const aborted = session([
    { role: "assistant", content: [], stopReason: "aborted" },
  ]) as any;
  assert.equal(
    describeSessionFailure(aborted, true),
    "Task aborted before producing output (task timeout)",
  );
  assert.equal(
    describeSessionFailure(aborted, false),
    "Task aborted before producing output",
  );
});

test("describeSessionFailure returns undefined for a normal stop with no output", () => {
  const reason = describeSessionFailure(
    session([
      { role: "assistant", content: [], stopReason: "stop" },
    ]) as any,
    false,
  );
  assert.equal(reason, undefined);
});

test("describeSessionFailure only inspects the LAST assistant message — a recovered earlier error is not reported", () => {
  const reason = describeSessionFailure(
    session([
      { role: "assistant", content: [], stopReason: "error", errorMessage: "transient" },
      { role: "assistant", content: [], stopReason: "stop" },
    ]) as any,
    false,
  );
  assert.equal(reason, undefined);
});

test("summarizeSessionTail reports roles, stopReasons and part-type counts without content", () => {
  const tail = summarizeSessionTail(
    session([
      { role: "user", content: "secret task text" },
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "private" },
          { type: "toolCall", id: "call_1" },
          { type: "toolCall", id: "call_2" },
        ],
      },
      { role: "assistant", stopReason: "error", errorMessage: "boom", content: [] },
    ]) as any,
  );

  assert.equal(tail.length, 3);
  assert.deepEqual(tail[1], {
    role: "assistant",
    stopReason: "toolUse",
    parts: { thinking: 1, toolCall: 2 },
  });
  assert.deepEqual(tail[2], {
    role: "assistant",
    stopReason: "error",
    errorMessage: "boom",
    parts: {},
  });
  // Content must never leak into logs — only lengths/counts.
  assert.ok(!JSON.stringify(tail).includes("secret task text"));
  assert.ok(!JSON.stringify(tail).includes("private"));
});

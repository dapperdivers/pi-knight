import test from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isLocalEndpoint, preflightModel, preflightModelUntilReady } from "../src/preflight.ts";

/** Minimal Model stub — only the fields preflight reads matter. */
function makeModel(overrides: Partial<Model<Api>>): Model<Api> {
  return {
    id: "llama3.1",
    name: "llama3.1",
    api: "openai-completions",
    provider: "ollama",
    baseUrl: "http://localhost:11434/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 16384,
    ...overrides,
  } as Model<Api>;
}

/** Install a fetch stub that routes by URL; returns the recorded request URLs. */
function stubFetch(routes: (url: string, init?: RequestInit) => { ok: boolean; status?: number; json?: () => unknown } | "throw") {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const r = routes(url, init);
    if (r === "throw") throw new Error("ECONNREFUSED");
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => (r.json ? r.json() : {}),
    } as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("isLocalEndpoint: provider name, localhost, and :11434 are local; cloud is not", () => {
  assert.equal(isLocalEndpoint(makeModel({ provider: "ollama", baseUrl: "http://my-svc:11434/v1" })), true);
  assert.equal(isLocalEndpoint(makeModel({ provider: "litellm", baseUrl: "http://localhost:4000/v1" })), true);
  assert.equal(isLocalEndpoint(makeModel({ provider: "x", baseUrl: "http://127.0.0.1:8080/v1" })), true);
  assert.equal(isLocalEndpoint(makeModel({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" })), false);
  assert.equal(isLocalEndpoint(makeModel({ provider: "anthropic", baseUrl: "https://api.anthropic.com" })), false);
});

test("preflightModel: cloud endpoint is a no-op (no network calls)", async () => {
  const { calls, restore } = stubFetch(() => ({ ok: true }));
  try {
    await preflightModel(makeModel({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }));
    assert.equal(calls.length, 0, "cloud endpoints must not be probed");
  } finally {
    restore();
  }
});

test("preflightModel: unreachable local endpoint fails fast with a helpful message", async () => {
  const { restore } = stubFetch(() => "throw");
  try {
    await assert.rejects(
      preflightModel(makeModel({ baseUrl: "http://localhost:11434/v1" })),
      /unreachable/i,
    );
  } finally {
    restore();
  }
});

test("preflightModel: reachable endpoint serving an unexpected non-200 fails fast", async () => {
  // /models reachable but returns 503 — endpoint up, not serving a model list.
  const { restore } = stubFetch((url) =>
    url.endsWith("/models") ? { ok: false, status: 503 } : { ok: true },
  );
  try {
    await assert.rejects(preflightModel(makeModel({})), /HTTP 503/);
  } finally {
    restore();
  }
});

test("preflightModel: model present (with :latest tag normalization) resolves and probes num_ctx", async () => {
  const { calls, restore } = stubFetch((url) => {
    if (url.endsWith("/models")) return { ok: true, json: () => ({ data: [{ id: "llama3.1:latest" }] }) };
    if (url.endsWith("/api/show")) return { ok: true, json: () => ({ parameters: "num_ctx 131072\nstop x" }) };
    return { ok: true };
  });
  try {
    await preflightModel(makeModel({ id: "llama3.1", contextWindow: 131072 }));
    assert.ok(calls.some((u) => u.endsWith("/v1/models")), "should probe OpenAI-compatible /models");
    assert.ok(calls.some((u) => u.endsWith("/api/show")), "should probe Ollama native /api/show for num_ctx");
  } finally {
    restore();
  }
});

test("preflightModel: missing model does not throw (fuzzy tags warn, not fail)", async () => {
  const { restore } = stubFetch((url) =>
    url.endsWith("/models")
      ? { ok: true, json: () => ({ data: [{ id: "qwen2.5" }] }) }
      : { ok: true, json: () => ({}) },
  );
  try {
    // llama3.1 not in the list — should warn loudly but not reject (avoids false-negative pod bricking).
    await preflightModel(makeModel({ id: "llama3.1" }));
  } finally {
    restore();
  }
});

test("preflightModel: /api/ps is authoritative — sufficient context skips /api/show", async () => {
  const { calls, restore } = stubFetch((url) => {
    if (url.endsWith("/models")) return { ok: true, json: () => ({ data: [{ id: "llama3.1" }] }) };
    if (url.endsWith("/api/ps")) return { ok: true, json: () => ({ models: [{ model: "llama3.1", context_length: 16384 }] }) };
    return { ok: true };
  });
  try {
    await preflightModel(makeModel({ id: "llama3.1", contextWindow: 16384 }));
    assert.ok(calls.some((u) => u.endsWith("/api/ps")), "should consult /api/ps for effective context");
    assert.ok(!calls.some((u) => u.endsWith("/api/show")), "/api/ps was authoritative; /api/show must be skipped");
  } finally {
    restore();
  }
});

test("preflightModel: /api/ps context below advertised window warns (not fatal)", async () => {
  const { calls, restore } = stubFetch((url) => {
    if (url.endsWith("/models")) return { ok: true, json: () => ({ data: [{ id: "llama3.1" }] }) };
    if (url.endsWith("/api/ps")) return { ok: true, json: () => ({ models: [{ model: "llama3.1", context_length: 8192 }] }) };
    return { ok: true };
  });
  try {
    await preflightModel(makeModel({ id: "llama3.1", contextWindow: 16384 })); // truncation footgun — warns, no throw
    assert.ok(!calls.some((u) => u.endsWith("/api/show")), "/api/ps was authoritative; /api/show must be skipped");
  } finally {
    restore();
  }
});

test("preflightModel: num_ctx probe failure is non-fatal", async () => {
  const { restore } = stubFetch((url) => {
    if (url.endsWith("/models")) return { ok: true, json: () => ({ data: [{ id: "llama3.1" }] }) };
    if (url.endsWith("/api/show")) return "throw"; // older Ollama / proxy without /api/show
    return { ok: true };
  });
  try {
    await preflightModel(makeModel({ id: "llama3.1" })); // must not reject
  } finally {
    restore();
  }
});

test("preflightModelUntilReady: retries with backoff until the endpoint answers, never rejects", async () => {
  let failuresLeft = 3;
  const { restore } = stubFetch((url) => {
    if (url.endsWith("/models")) {
      if (failuresLeft > 0) {
        failuresLeft--;
        return "throw"; // unreachable endpoint
      }
      return { ok: true, json: () => ({ data: [{ id: "llama3.1" }] }) };
    }
    return { ok: true, json: () => ({}) };
  });

  const sleeps: number[] = [];
  const failures: Array<{ attempt: number; error: string }> = [];
  try {
    await preflightModelUntilReady(makeModel({ id: "llama3.1" }), {
      initialDelayMs: 10,
      maxDelayMs: 25,
      sleep: async (ms) => { sleeps.push(ms); },
      onAttemptFailed: (error, attempt) => failures.push({ attempt, error }),
    });
  } finally {
    restore();
  }

  assert.equal(failures.length, 3, "one onAttemptFailed per failed probe");
  assert.ok(failures.every((f) => f.error.includes("unreachable")), "reason carries the preflight error");
  assert.deepEqual(sleeps, [10, 20, 25], "exponential backoff capped at maxDelayMs");
});

test("preflightModelUntilReady: cloud endpoint resolves immediately with no retries", async () => {
  const { calls, restore } = stubFetch(() => ({ ok: true }));
  try {
    await preflightModelUntilReady(
      makeModel({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }),
      { sleep: async () => { assert.fail("must not sleep"); } },
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

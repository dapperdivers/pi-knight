import test from "node:test";
import assert from "node:assert/strict";
import { parseModelStr, splitRoutingSuffix, resolveModel, createTrustedSettingsManager } from "../src/model.ts";

test("parseModelStr splits provider from model, defaulting to anthropic", () => {
  assert.deepEqual(parseModelStr("openrouter/deepseek/deepseek-v3.2"), {
    provider: "openrouter",
    modelName: "deepseek/deepseek-v3.2",
  });
  assert.deepEqual(parseModelStr("claude-opus-4-8"), {
    provider: "anthropic",
    modelName: "claude-opus-4-8",
  });
});

test("splitRoutingSuffix strips known OpenRouter routing variants", () => {
  for (const suffix of ["floor", "nitro", "free", "online", "exacto"]) {
    assert.deepEqual(splitRoutingSuffix(`deepseek/deepseek-v3.2:${suffix}`), {
      base: "deepseek/deepseek-v3.2",
      suffix,
    });
  }
});

test("splitRoutingSuffix leaves plain slugs untouched", () => {
  assert.deepEqual(splitRoutingSuffix("deepseek/deepseek-v3.2"), { base: "deepseek/deepseek-v3.2" });
});

test("splitRoutingSuffix does not treat thinking levels as routing suffixes", () => {
  // ":high" is a thinking level handled downstream by the SDK, not a routing variant.
  assert.deepEqual(splitRoutingSuffix("claude-opus-4-8:high"), { base: "claude-opus-4-8:high" });
});

test("splitRoutingSuffix leaves unknown suffixes intact", () => {
  assert.deepEqual(splitRoutingSuffix("some/model:bogus"), { base: "some/model:bogus" });
});

test("resolveModel defaults the ollama provider to the local Ollama OpenAI endpoint", () => {
  const prevBase = process.env.OPENAI_BASE_URL;
  const prevApiBase = process.env.OPENAI_API_BASE;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_API_BASE;
  try {
    const { model, provider, modelName } = resolveModel("ollama/llama3.1");
    assert.equal(provider, "ollama");
    assert.equal(modelName, "llama3.1");
    assert.equal(model.baseUrl, "http://localhost:11434/v1");
  } finally {
    if (prevBase !== undefined) process.env.OPENAI_BASE_URL = prevBase;
    if (prevApiBase !== undefined) process.env.OPENAI_API_BASE = prevApiBase;
  }
});

test("createTrustedSettingsManager returns a project-trusted manager (pi 0.79 trust gating)", () => {
  const sm = createTrustedSettingsManager(process.cwd(), process.cwd());
  assert.equal(sm.isProjectTrusted(), true);
});

test("resolveModel makes the fallback model's reasoning flag env-overridable", () => {
  const prev = process.env.MODEL_REASONING;
  try {
    delete process.env.MODEL_REASONING;
    assert.equal(resolveModel("ollama/gpt-oss:20b").model.reasoning, false, "defaults off");

    process.env.MODEL_REASONING = "true";
    assert.equal(resolveModel("ollama/gpt-oss:20b").model.reasoning, true, "opt-in for reasoning models");
  } finally {
    if (prev !== undefined) process.env.MODEL_REASONING = prev;
    else delete process.env.MODEL_REASONING;
  }
});

test("resolveModel honors an explicit OPENAI_BASE_URL over the ollama default", () => {
  const prevBase = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = "http://ollama.ai.svc.cluster.local:11434/v1";
  try {
    const { model } = resolveModel("ollama/llama3.1");
    assert.equal(model.baseUrl, "http://ollama.ai.svc.cluster.local:11434/v1");
  } finally {
    if (prevBase !== undefined) process.env.OPENAI_BASE_URL = prevBase;
    else delete process.env.OPENAI_BASE_URL;
  }
});

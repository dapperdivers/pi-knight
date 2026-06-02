import test from "node:test";
import assert from "node:assert/strict";
import { parseModelStr, splitRoutingSuffix } from "../src/model.ts";

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

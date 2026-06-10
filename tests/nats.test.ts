import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTimeoutMs } from "../src/nats.ts";

test("normalizeTimeoutMs keeps positive finite timeouts", () => {
  assert.equal(normalizeTimeoutMs(1800000), 1800000);
  assert.equal(normalizeTimeoutMs(1), 1);
});

test("normalizeTimeoutMs treats 0 and negatives as unset (the #30 instant-abort bug)", () => {
  assert.equal(normalizeTimeoutMs(0), undefined);
  assert.equal(normalizeTimeoutMs(-5), undefined);
});

test("normalizeTimeoutMs rejects non-finite and non-number inputs", () => {
  assert.equal(normalizeTimeoutMs(NaN), undefined);
  assert.equal(normalizeTimeoutMs(Infinity), undefined);
  assert.equal(normalizeTimeoutMs(undefined), undefined);
  assert.equal(normalizeTimeoutMs(null), undefined);
  assert.equal(normalizeTimeoutMs("1000"), undefined);
});

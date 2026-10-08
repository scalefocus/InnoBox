import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCallbackParams } from "./validation.js";

const VALID = { code: "auth-code", state: "s1", errorParam: null, expectedState: "s1", verifier: "v1" };

test("validateCallbackParams: accepts matching code/state/verifier", () => {
  const result = validateCallbackParams(VALID);
  assert.deepEqual(result, { ok: true, code: "auth-code", verifier: "v1" });
});

test("validateCallbackParams: an upstream error param short-circuits with its own code", () => {
  const result = validateCallbackParams({ ...VALID, errorParam: "access_denied" });
  assert.deepEqual(result, { ok: false, errorCode: "access_denied" });
});

test("validateCallbackParams: rejects a state mismatch (CSRF-shaped attack)", () => {
  const result = validateCallbackParams({ ...VALID, state: "attacker-supplied" });
  assert.deepEqual(result, { ok: false, errorCode: "invalid_state" });
});

test("validateCallbackParams: rejects missing code, missing state, or missing cookies", () => {
  assert.deepEqual(validateCallbackParams({ ...VALID, code: null }), { ok: false, errorCode: "invalid_state" });
  assert.deepEqual(validateCallbackParams({ ...VALID, state: null }), { ok: false, errorCode: "invalid_state" });
  assert.deepEqual(validateCallbackParams({ ...VALID, expectedState: undefined }), { ok: false, errorCode: "invalid_state" });
  assert.deepEqual(validateCallbackParams({ ...VALID, verifier: undefined }), { ok: false, errorCode: "invalid_state" });
});

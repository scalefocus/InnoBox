// INNOBOX_SPEC.md §24.4: the browser's solver finds exactly the number the server hid, against a
// challenge the server's own issuer produced, and the server accepts the answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { issuePowChallenge, verifyPowSolution } from "@innobox/shared";
import { solvePow } from "./pow-solver";

const KEY = Buffer.alloc(32, 3);

test("the solver's answer verifies on the server", async () => {
  const now = Date.now();
  const c = issuePowChallenge(KEY, now, 2_000);
  const number = await solvePow(c);
  assert.notEqual(number, null);
  assert.deepEqual(verifyPowSolution(KEY, { salt: c.salt, number: number!, signature: c.signature }, now + 1_000, 2_000), { ok: true, issuedAtMs: now });
});

test("a challenge with no solution in range yields null; an aborted search stops", async () => {
  assert.equal(await solvePow({ salt: "x", challenge: "0".repeat(64), maxNumber: 300 }), null);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await solvePow({ salt: "x", challenge: "0".repeat(64), maxNumber: 1_000_000 }, controller.signal), null);
});

// Unit tests for the POST /api/ai/draft parser (INNOBOX_SPEC.md §22.10): only the egress fields
// are accepted — a client name or anonymity flag in the body never survives parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDraftRequest } from "./validation";

test("challenge: title/description/visibility only; something to improve", () => {
  const ok = parseDraftRequest({ kind: "challenge", title: "T", description: "D", visibility: "org", clientName: "ACME", isAnonymous: true });
  assert.deepEqual(ok, { ok: true, value: { kind: "challenge", title: "T", description: "D", visibility: "org" } });
  assert.equal(parseDraftRequest({ kind: "challenge", title: " ", description: "", visibility: "org" }).ok, false);
  assert.equal(parseDraftRequest({ kind: "challenge", title: "T", visibility: "everyone" }).ok, false);
  assert.equal(parseDraftRequest({ kind: "challenge", title: "x".repeat(121), visibility: "org" }).ok, false);
});

test("solution: challenge number, description, cost vs benefits", () => {
  const ok = parseDraftRequest({ kind: "solution", challengeNumber: "CH-12", description: "D", costVsBenefits: null, isAnonymous: true });
  assert.deepEqual(ok, { ok: true, value: { kind: "solution", challengeNumber: "12", description: "D", costVsBenefits: "" } });
  assert.equal(parseDraftRequest({ kind: "solution", challengeNumber: "abc", description: "D" }).ok, false);
  assert.equal(parseDraftRequest({ kind: "solution", challengeNumber: "12", description: "" }).ok, false);
  assert.equal(parseDraftRequest({ kind: "comment" }).ok, false);
});

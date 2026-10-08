import { test } from "node:test";
import assert from "node:assert/strict";
import { canAssignAtStatus, canEditOwnComment, finalizeRecipients, validateCommentBody } from "./social.js";

const AUTHOR = "11111111-0000-0000-0000-000000000001";
const OTHER = "22222222-0000-0000-0000-000000000002";

test("validateCommentBody: rejects blank and over-length bodies", () => {
  assert.equal(validateCommentBody("   ").ok, false);
  assert.equal(validateCommentBody("x".repeat(5001)).ok, false);
});

test("validateCommentBody: trims and accepts a normal body", () => {
  const result = validateCommentBody("  Nice idea!  ");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value, "Nice idea!");
});

test("canEditOwnComment: true for the author within 15 minutes", () => {
  const createdAt = new Date("2026-01-01T12:00:00Z");
  const now = new Date("2026-01-01T12:10:00Z");
  assert.equal(canEditOwnComment({ authorId: AUTHOR, createdAt }, AUTHOR, now), true);
});

test("canEditOwnComment: false after 15 minutes", () => {
  const createdAt = new Date("2026-01-01T12:00:00Z");
  const now = new Date("2026-01-01T12:15:01Z");
  assert.equal(canEditOwnComment({ authorId: AUTHOR, createdAt }, AUTHOR, now), false);
});

test("canEditOwnComment: false for a non-author regardless of time", () => {
  const createdAt = new Date("2026-01-01T12:00:00Z");
  const now = new Date("2026-01-01T12:00:01Z");
  assert.equal(canEditOwnComment({ authorId: AUTHOR, createdAt }, OTHER, now), false);
});

test("canAssignAtStatus: true for non-terminal statuses, false for terminal", () => {
  assert.equal(canAssignAtStatus("awaiting_triage"), true);
  assert.equal(canAssignAtStatus("valid"), true);
  assert.equal(canAssignAtStatus("solved"), false);
  assert.equal(canAssignAtStatus("rejected"), false);
  assert.equal(canAssignAtStatus("withdrawn"), false);
});

test("finalizeRecipients: drops the actor and dedupes", () => {
  const result = finalizeRecipients([AUTHOR, OTHER, AUTHOR, "3"], AUTHOR);
  assert.deepEqual(result, [OTHER, "3"]);
});

test("finalizeRecipients: actorId null keeps everyone (system-triggered events)", () => {
  const result = finalizeRecipients([AUTHOR, OTHER], null);
  assert.deepEqual(result, [AUTHOR, OTHER]);
});

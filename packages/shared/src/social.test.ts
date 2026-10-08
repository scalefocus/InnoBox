import { test } from "node:test";
import assert from "node:assert/strict";
import { areLikesFrozen, canAssignAtStatus, canEditOwnComment, finalizeRecipients, validateCommentBody } from "./social.js";

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

test("areLikesFrozen: only a solved challenge freezes likes", () => {
  assert.equal(areLikesFrozen("solved"), true);
  for (const s of ["awaiting_triage", "in_review", "needs_improvement", "meeting_scheduled", "valid", "rejected", "withdrawn"] as const) {
    assert.equal(areLikesFrozen(s), false, s);
  }
});

test("finalizeRecipients: drops the actor and dedupes", () => {
  const result = finalizeRecipients([AUTHOR, OTHER, AUTHOR, "3"], AUTHOR);
  assert.deepEqual(result, [OTHER, "3"]);
});

test("finalizeRecipients: actorId null keeps everyone (system-triggered events)", () => {
  const result = finalizeRecipients([AUTHOR, OTHER], null);
  assert.deepEqual(result, [AUTHOR, OTHER]);
});

test("commentNotificationMessage: singular, then the coalesced count with the latest commenter", async () => {
  const { commentNotificationMessage } = await import("./social.js");
  assert.equal(commentNotificationMessage(1, "CH-412", "Warehouse pick-path", "Alice"), 'New comment on CH-412 "Warehouse pick-path" — by Alice.');
  assert.equal(commentNotificationMessage(3, "CH-412", "Warehouse pick-path", "Bob"), '3 new comments on CH-412 "Warehouse pick-path" — latest by Bob.');
});

test("assignmentsTransferredMessage: singular, plural, and the 10-number cap with 'and K more'", async () => {
  const { assignmentsTransferredMessage, ASSIGNMENTS_TRANSFERRED_LIST_MAX } = await import("./social.js");
  assert.equal(assignmentsTransferredMessage(["CH-12"]), "1 challenge was reassigned to you from a removed account: CH-12.");
  assert.equal(
    assignmentsTransferredMessage(["CH-12", "CH-40"]),
    "2 challenges were reassigned to you from a removed account: CH-12, CH-40.",
  );
  assert.equal(ASSIGNMENTS_TRANSFERRED_LIST_MAX, 10);
  const thirteen = Array.from({ length: 13 }, (_, i) => `CH-${i + 1}`);
  assert.equal(
    assignmentsTransferredMessage(thirteen),
    "13 challenges were reassigned to you from a removed account: CH-1, CH-2, CH-3, CH-4, CH-5, CH-6, CH-7, CH-8, CH-9, CH-10 and 3 more.",
  );
  const ten = thirteen.slice(0, 10);
  assert.ok(!assignmentsTransferredMessage(ten).includes("more"), "exactly ten numbers need no 'and K more'");
});

test("NOTIFICATION_TYPES: includes the erasure hand-over summary type", async () => {
  const { NOTIFICATION_TYPES } = await import("./social.js");
  assert.ok((NOTIFICATION_TYPES as readonly string[]).includes("assignments_transferred"));
});

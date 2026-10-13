// Unit tests for the challenge-detail presentation rules (INNOBOX_SPEC.md §6.2, §8.3, §13.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { RESTORE_CHALLENGE_FIRST as SERVER_RESTORE_CHALLENGE_FIRST } from "@innobox/shared";
import { LIKES_FROZEN_HINT, RESTORE_CHALLENGE_FIRST, proposeDisabledReason, splitSolutions } from "./challenge-detail";

test("proposeDisabledReason: enabled only while valid", () => {
  assert.equal(proposeDisabledReason("valid"), null);
  for (const s of ["awaiting_triage", "in_review", "needs_improvement", "meeting_scheduled", "solved", "rejected", "withdrawn"]) {
    const reason = proposeDisabledReason(s);
    assert.ok(reason && reason.length > 0, `${s} explains why proposing is disabled`);
  }
});

test("proposeDisabledReason: solved and closed statuses say so; pre-validation ones point forward", () => {
  assert.match(proposeDisabledReason("solved")!, /solved/);
  assert.match(proposeDisabledReason("rejected")!, /closed/);
  assert.match(proposeDisabledReason("withdrawn")!, /closed/);
  assert.match(proposeDisabledReason("in_review")!, /validated/);
});

test("proposeDisabledReason: an archived namespace disables proposing and outranks every status", () => {
  for (const s of ["valid", "awaiting_triage", "in_review", "solved", "rejected", "withdrawn"]) {
    assert.match(proposeDisabledReason(s, true)!, /namespace is archived/, `${s} in an archived namespace`);
  }
  assert.equal(proposeDisabledReason("valid", false), null);
});

test("the copy carries no spec references (invariant 9)", () => {
  for (const s of ["valid", "solved", "rejected", "in_review"]) assert.ok(!(proposeDisabledReason(s) ?? "").includes("§"));
  assert.ok(!proposeDisabledReason("valid", true)!.includes("§"));
  assert.ok(!LIKES_FROZEN_HINT.includes("§"));
});

test("the frozen-likes hint names no particular status", () => {
  for (const s of ["solved", "rejected", "withdrawn"]) assert.ok(!LIKES_FROZEN_HINT.includes(s), s);
});

test("splitSolutions: rejected, not_selected and withdrawn go to the closed list, order kept", () => {
  const rows = [
    { id: "1", status: "proposed" },
    { id: "2", status: "rejected" },
    { id: "3", status: "valid" },
    { id: "4", status: "not_selected" },
    { id: "5", status: "implemented" },
    { id: "6", status: "withdrawn" },
    { id: "7", status: "needs_improvement" },
  ];
  const { open, closed } = splitSolutions(rows);
  assert.deepEqual(
    open.map((r) => r.id),
    ["1", "3", "5", "7"],
  );
  assert.deepEqual(
    closed.map((r) => r.id),
    ["2", "4", "6"],
  );
  assert.deepEqual(splitSolutions([]), { open: [], closed: [] });
});

test("splitSolutions: a trashed solution is listed with the closed ones, whatever its status (§10.4)", () => {
  const { open, closed } = splitSolutions([
    { id: "1", status: "valid", trashed: null },
    { id: "2", status: "valid", trashed: { at: "x" } },
    { id: "3", status: "implemented" },
  ]);
  assert.deepEqual(open.map((r) => r.id), ["1", "3"]);
  assert.deepEqual(closed.map((r) => r.id), ["2"]);
});

test("the Restore tooltip uses the same words the restore endpoint refuses with", () => {
  assert.equal(RESTORE_CHALLENGE_FIRST, SERVER_RESTORE_CHALLENGE_FIRST);
});

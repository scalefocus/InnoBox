// Unit tests for the challenge-detail presentation rules (INNOBOX_SPEC.md §6.2, §8.3, §13.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIKES_FROZEN_HINT, proposeDisabledReason } from "./challenge-detail";

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

test("the copy carries no spec references (invariant 9)", () => {
  for (const s of ["valid", "solved", "rejected", "in_review"]) assert.ok(!(proposeDisabledReason(s) ?? "").includes("§"));
  assert.ok(!LIKES_FROZEN_HINT.includes("§"));
});

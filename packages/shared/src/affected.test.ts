// §41 "this affects me too" rules (INNOBOX_SPEC.md §41.2–§41.6, §41.10): the headcount and
// estimate parsers, the eligibility matrix, the reach arithmetic and the copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHALLENGE_STATUSES } from "./challenges.js";
import {
  AFFECTED_HEADCOUNT_MAX,
  AFFECTED_MESSAGES,
  affectedBreakdown,
  affectedButtonLabel,
  affectedDigestLine,
  affectedEmailDetail,
  affectedEmailSubject,
  affectedNotificationMessage,
  affectedReach,
  challengeAffectedPeopleSql,
  challengeReachSql,
  decideAffected,
  formatCount,
  isAffectedOpen,
  parseAffectedEstimate,
  parseHeadcount,
  reachLabel,
} from "./affected.js";

test("parseHeadcount: whole numbers 1–1,000 only", () => {
  assert.deepEqual(parseHeadcount(1), { ok: true, value: 1 });
  assert.deepEqual(parseHeadcount(AFFECTED_HEADCOUNT_MAX), { ok: true, value: 1000 });
  for (const bad of [0, 1001, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "12", null, undefined, true, {}]) {
    assert.deepEqual(parseHeadcount(bad), { ok: false, error: AFFECTED_MESSAGES.invalidHeadcount }, String(bad));
  }
});

test("parseAffectedEstimate: null means not given; otherwise the headcount rules", () => {
  assert.deepEqual(parseAffectedEstimate(null), { ok: true, value: null });
  assert.deepEqual(parseAffectedEstimate(30), { ok: true, value: 30 });
  assert.equal(parseAffectedEstimate(0).ok, false);
  assert.equal(parseAffectedEstimate("30").ok, false);
  assert.equal(parseAffectedEstimate(undefined).ok, false);
});

test("isAffectedOpen: past triage and not closed", () => {
  const open = CHALLENGE_STATUSES.filter(isAffectedOpen);
  assert.deepEqual([...open].sort(), ["in_review", "meeting_scheduled", "needs_improvement", "valid"]);
});

test("decideAffected: own first, then the trash, then not yet triaged, then closed", () => {
  for (const status of CHALLENGE_STATUSES) {
    const own = decideAffected({ status, isAuthor: true, trashed: false });
    assert.deepEqual(own, { canMark: false, reason: "own" }, status);
    const other = decideAffected({ status, isAuthor: false, trashed: false });
    if (status === "awaiting_triage") assert.deepEqual(other, { canMark: false, reason: "not_yet" });
    else if (isAffectedOpen(status)) assert.deepEqual(other, { canMark: true, reason: null });
    else assert.deepEqual(other, { canMark: false, reason: "closed" }, status);
    assert.deepEqual(decideAffected({ status, isAuthor: false, trashed: true }), { canMark: false, reason: "closed" }, status);
  }
  // An author's own trashed challenge still reads "own" — the button stays hidden.
  assert.equal(decideAffected({ status: "valid", isAuthor: true, trashed: true }).reason, "own");
});

test("affectedReach: an empty estimate counts the authors as 1; marks add up", () => {
  assert.equal(affectedReach(null, []), 1);
  assert.equal(affectedReach(30, []), 30);
  assert.equal(affectedReach(null, [12, 3]), 16);
  assert.equal(affectedReach(30, [12, 1000]), 1042);
});

test("the SQL twins read only current marks and default the estimate to 1", () => {
  const reach = challengeReachSql("c");
  assert.match(reach, /coalesce\(c\.affected_estimate, 1\)/);
  assert.match(reach, /removed_at is null/);
  assert.match(challengeAffectedPeopleSql("x"), /ca\.challenge_id = x\.id and ca\.removed_at is null/);
});

test("formatCount and reachLabel", () => {
  assert.equal(formatCount(7), "7");
  assert.equal(formatCount(1240), "1,240");
  assert.equal(formatCount(1234567), "1,234,567");
  assert.equal(reachLabel(1), "1 person affected");
  assert.equal(reachLabel(2), "About 2 people affected");
  assert.equal(reachLabel(1240), "About 1,240 people affected");
});

test("affectedButtonLabel", () => {
  assert.equal(affectedButtonLabel(null), "This affects me too");
  assert.equal(affectedButtonLabel(12), "Affects me · 12");
});

test("affectedBreakdown: estimate, empty estimate, team, external, nobody else", () => {
  assert.equal(
    affectedBreakdown({ estimate: 30, teamSize: 1, external: false, people: 8 }),
    "The author's estimate of 30, plus 8 colleagues who say it affects them too.",
  );
  assert.equal(affectedBreakdown({ estimate: 30, teamSize: 3, external: false, people: 1 }), "The authors' estimate of 30, plus 1 colleague who says it affects them too.");
  assert.equal(affectedBreakdown({ estimate: null, teamSize: 1, external: false, people: 2 }), "The author, plus 2 colleagues who say it affects them too.");
  assert.equal(affectedBreakdown({ estimate: null, teamSize: 2, external: false, people: 0 }), "The authors.");
  assert.equal(affectedBreakdown({ estimate: null, teamSize: 1, external: true, people: 4 }), "The outside submitter, plus 4 colleagues who say it affects them too.");
  assert.equal(affectedBreakdown({ estimate: 5, teamSize: 1, external: false, people: 0 }), "The author's estimate of 5.");
});

test("event 24 copy: single, coalesced, subject, e-mail detail, digest line", () => {
  assert.equal(affectedNotificationMessage(1, "CH-412", "Alice"), "Alice says CH-412 affects them too.");
  assert.equal(affectedNotificationMessage(3, "CH-412", "Alice"), "3 people say CH-412 affects them too — latest Alice.");
  assert.equal(affectedEmailSubject("Alice", "CH-412"), "Alice says your challenge CH-412 affects them too");
  assert.equal(
    affectedEmailDetail({ headcount: 12, challengeNumber: "CH-412", title: "Slow VPN", reach: 120, people: 8 }),
    'They count 12 people, themselves included. CH-412 "Slow VPN": about 120 people affected — 8 colleagues say it affects them.',
  );
  assert.match(affectedEmailDetail({ headcount: 1, challengeNumber: "CH-1", title: "T", reach: 2, people: 1 }), /^They count only themselves\. .* 1 colleague says/);
  assert.equal(affectedDigestLine(1, 13), "1 more person says it affects them — about 13 in all");
  assert.equal(affectedDigestLine(3, 1240), "3 more people say it affects them — about 1,240 in all");
  assert.equal(affectedDigestLine(2, null), "2 more people say it affects them");
});

test("no copy carries a spec reference", () => {
  const copy = [
    ...Object.values(AFFECTED_MESSAGES),
    reachLabel(5),
    affectedBreakdown({ estimate: 3, teamSize: 1, external: false, people: 2 }),
    affectedNotificationMessage(2, "CH-1", "A"),
  ];
  for (const line of copy) assert.doesNotMatch(line, /§/);
});

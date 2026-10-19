// §26 hype rules (INNOBOX_SPEC.md §26.2–§26.4, §26.11): the week boundary, the budget, the
// early-hype weight, the eligibility matrix and the copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHALLENGE_STATUSES, SOLUTION_STATUSES } from "./challenges.js";
import {
  HYPES_PER_WEEK,
  HYPE_MESSAGES,
  decideHype,
  hypeBudgetLine,
  hypeButtonLabel,
  hypeTooltip,
  hypeWeight,
  hypesLeft,
  isChallengeHypeOpen,
  isEarlyHype,
  isSolutionHypeOpen,
  nextWeekStartUtc,
  weekStartUtc,
} from "./hype.js";

test("weekStartUtc: Sunday 23:59:59 UTC belongs to the week that started the previous Monday", () => {
  // 2026-10-18 is a Sunday; 2026-10-12 the Monday before it.
  assert.equal(weekStartUtc(new Date("2026-10-18T23:59:59.999Z")).toISOString(), "2026-10-12T00:00:00.000Z");
});

test("weekStartUtc: Monday 00:00:00 UTC starts a new week, and a Monday mid-day is its own start", () => {
  assert.equal(weekStartUtc(new Date("2026-10-19T00:00:00.000Z")).toISOString(), "2026-10-19T00:00:00.000Z");
  assert.equal(weekStartUtc(new Date("2026-10-19T15:30:00.000Z")).toISOString(), "2026-10-19T00:00:00.000Z");
});

test("weekStartUtc: local time plays no part — the same instant gives the same Monday whatever the zone", () => {
  // Built from a local-time constructor and from a UTC string: both are the same instant.
  const instant = new Date("2026-10-18T23:30:00.000Z");
  const viaLocal = new Date(instant.getTime());
  assert.equal(weekStartUtc(viaLocal).getTime(), weekStartUtc(instant).getTime());
  assert.equal(weekStartUtc(instant).getUTCDay(), 1);
  assert.equal(weekStartUtc(instant).getUTCHours(), 0);
});

test("nextWeekStartUtc: seven days after the week's start", () => {
  assert.equal(nextWeekStartUtc(new Date("2026-10-18T23:59:59.999Z")).toISOString(), "2026-10-19T00:00:00.000Z");
  assert.equal(nextWeekStartUtc(new Date("2026-10-19T00:00:00.000Z")).toISOString(), "2026-10-26T00:00:00.000Z");
});

test("hypesLeft: 3 minus the hypes used, never below zero", () => {
  assert.equal(HYPES_PER_WEEK, 3);
  assert.equal(hypesLeft(0), 3);
  assert.equal(hypesLeft(2), 1);
  assert.equal(hypesLeft(3), 0);
  assert.equal(hypesLeft(7), 0);
  assert.equal(hypesLeft(-1), 3);
});

test("hypeWeight: 2 inside the first 7 days, 1 at exactly 7 days and after", () => {
  const created = new Date("2026-10-01T12:00:00.000Z");
  assert.equal(hypeWeight(created, new Date("2026-10-01T12:00:00.000Z")), 2);
  assert.equal(hypeWeight(created, new Date("2026-10-08T11:59:59.999Z")), 2);
  assert.equal(hypeWeight(created, new Date("2026-10-08T12:00:00.000Z")), 1);
  assert.equal(hypeWeight(created, new Date("2027-01-01T00:00:00.000Z")), 1);
  assert.equal(isEarlyHype(created, new Date("2026-10-02T00:00:00.000Z")), true);
  assert.equal(isEarlyHype(created, new Date("2026-10-09T00:00:00.000Z")), false);
});

test("isChallengeHypeOpen: the four open statuses only — never awaiting_triage or a closed state", () => {
  const open = CHALLENGE_STATUSES.filter(isChallengeHypeOpen);
  assert.deepEqual(open, ["in_review", "needs_improvement", "meeting_scheduled", "valid"]);
});

test("isSolutionHypeOpen: every non-terminal solution status under an open parent; nothing under a closed one", () => {
  const open = SOLUTION_STATUSES.filter((s) => isSolutionHypeOpen(s, "valid"));
  assert.deepEqual(open, [
    "proposed",
    "in_review",
    "needs_improvement",
    "valid",
    "accepted_internally",
    "waiting_for_resources",
    "in_implementation",
    "external_acceptance",
  ]);
  for (const parent of ["solved", "rejected", "withdrawn", "awaiting_triage"] as const) {
    assert.equal(SOLUTION_STATUSES.some((s) => isSolutionHypeOpen(s, parent)), false, parent);
  }
});

test("decideHype: closed before own before hyped before budget; otherwise allowed", () => {
  assert.deepEqual(decideHype({ open: false, isAuthor: true, alreadyHyped: true, usedThisWeek: 3 }), { canHype: false, reason: "closed" });
  assert.deepEqual(decideHype({ open: true, isAuthor: true, alreadyHyped: true, usedThisWeek: 3 }), { canHype: false, reason: "own" });
  assert.deepEqual(decideHype({ open: true, isAuthor: false, alreadyHyped: true, usedThisWeek: 3 }), { canHype: false, reason: "hyped" });
  assert.deepEqual(decideHype({ open: true, isAuthor: false, alreadyHyped: false, usedThisWeek: 3 }), { canHype: false, reason: "budget" });
  assert.deepEqual(decideHype({ open: true, isAuthor: false, alreadyHyped: false, usedThisWeek: 2 }), { canHype: true, reason: null });
});

test("copy: the closed and own refusals share one message, and nothing cites the spec", () => {
  assert.equal(HYPE_MESSAGES.closed, HYPE_MESSAGES.own);
  for (const message of Object.values(HYPE_MESSAGES)) assert.equal(message.includes("§"), false);
  assert.equal(hypeButtonLabel(2), "Hype · 2 left this week");
  assert.equal(hypeBudgetLine(1), "You have 1 hype left this week");
  assert.equal(hypeBudgetLine(3), "You have 3 hypes left this week");
  assert.equal(hypeBudgetLine(0), "You've used this week's hypes — they reset on Monday");
  assert.equal(hypeTooltip(true).includes("double"), true);
  assert.equal(hypeTooltip(false).includes("double"), false);
});

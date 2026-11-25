// Unit tests for the implementation board's pure half (INNOBOX_SPEC.md §46): the moves a viewer has
// on a card and their mode, the on-board rule, the 90-day edge, both orders, the query parser, the
// long-column arithmetic and the copy. The rows, the predicate and the PATCH are integration-tested.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHALLENGE_STATUSES,
  SOLUTION_STATUSES,
  IMPLEMENTATION_BOARD_COLUMNS,
  IMPLEMENTATION_BOARD_COLUMN_MAX,
  IMPLEMENTATION_BOARD_PAGE,
  IMPLEMENTATION_BOARD_REFRESH_MS,
  IMPLEMENTATION_BOARD_WINDOW_DAYS,
  BOARD_COPY,
  boardMoves,
  boardQueryString,
  classifyMoveAnswer,
  columnCapLine,
  compareBoardCards,
  implementedConfirmText,
  isOnBoard,
  movedAnnouncement,
  parseBoardQuery,
  retiredTopicOption,
  sanitizeBoardQuery,
  showMoreCount,
  showingToInclude,
  solutionEnforcedTargets,
  timeInStageText,
} from "./index.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-25T12:00:00Z");
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("the five columns, in board order, and the fixed limits", () => {
  assert.deepEqual([...IMPLEMENTATION_BOARD_COLUMNS], ["accepted_internally", "waiting_for_resources", "in_implementation", "external_acceptance", "implemented"]);
  assert.equal(IMPLEMENTATION_BOARD_WINDOW_DAYS, 90);
  assert.equal(IMPLEMENTATION_BOARD_REFRESH_MS, 30_000);
  assert.equal(IMPLEMENTATION_BOARD_PAGE, 30);
  assert.equal(IMPLEMENTATION_BOARD_COLUMN_MAX, 100);
});

test("an admin moves to the other three in-progress columns and Implemented, never out of Implemented", () => {
  assert.deepEqual(boardMoves({ status: "accepted_internally", isAdmin: true, isEnforcer: false }), {
    moves: ["waiting_for_resources", "in_implementation", "external_acceptance", "implemented"],
    mode: "override",
  });
  assert.deepEqual(boardMoves({ status: "external_acceptance", isAdmin: true, isEnforcer: false }).moves, [
    "accepted_internally",
    "waiting_for_resources",
    "in_implementation",
    "implemented",
  ]);
  assert.deepEqual(boardMoves({ status: "implemented", isAdmin: true, isEnforcer: true }), { moves: [], mode: null });
});

test("an admin who is also a committee member or the assignee gets the admin's list and override", () => {
  const r = boardMoves({ status: "waiting_for_resources", isAdmin: true, isEnforcer: true });
  assert.equal(r.mode, "override");
  assert.equal(r.moves.length, 4);
});

test("a committee member or the assignee gets the §8.2 arrows without rejected, enforced", () => {
  for (const status of IMPLEMENTATION_BOARD_COLUMNS) {
    const r = boardMoves({ status, isAdmin: false, isEnforcer: true });
    const expected = solutionEnforcedTargets(status).filter((t) => t !== "rejected");
    assert.deepEqual(r.moves, expected, status);
    assert.equal(r.mode, expected.length > 0 ? "enforced" : null, status);
    assert.ok(!r.moves.includes("rejected" as never));
  }
});

test("anyone else — a barred author or a plain viewer — has no moves and no mode", () => {
  for (const status of IMPLEMENTATION_BOARD_COLUMNS) {
    assert.deepEqual(boardMoves({ status, isAdmin: false, isEnforcer: false }), { moves: [], mode: null });
  }
  assert.deepEqual(boardMoves({ status: "valid", isAdmin: true, isEnforcer: true }), { moves: [], mode: null });
});

test("the on-board rule over every pair of solution and challenge status", () => {
  const recent = new Date(NOW.getTime() - DAY);
  for (const s of SOLUTION_STATUSES) {
    for (const c of CHALLENGE_STATUSES) {
      const expected = (IMPLEMENTATION_BOARD_COLUMNS as readonly string[]).includes(s) && (c === "valid" || c === "solved");
      assert.equal(
        isOnBoard({ solutionStatus: s, challengeStatus: c, statusChangedAt: recent, trashed: false, challengeTrashed: false, now: NOW }),
        expected,
        `${s} under ${c}`,
      );
    }
  }
  const base = { solutionStatus: "in_implementation", challengeStatus: "valid", statusChangedAt: recent, now: NOW };
  assert.equal(isOnBoard({ ...base, trashed: true, challengeTrashed: false }), false);
  assert.equal(isOnBoard({ ...base, trashed: false, challengeTrashed: true }), false);
});

test("the 90-day edge: a second inside is on, a second outside is off; in progress never ages out", () => {
  const edge = NOW.getTime() - 90 * DAY;
  const at = (ms: number, status = "implemented") =>
    isOnBoard({ solutionStatus: status, challengeStatus: "solved", statusChangedAt: new Date(ms), trashed: false, challengeTrashed: false, now: NOW });
  assert.equal(at(edge + 1000), true);
  assert.equal(at(edge - 1000), false);
  assert.equal(at(edge - 400 * DAY, "in_implementation"), true);
});

test("order: in progress oldest first then lower number; Implemented newest first then higher number", () => {
  const a = { status: "in_implementation", statusChangedAt: "2026-01-01T00:00:00Z", number: 9 };
  const b = { status: "in_implementation", statusChangedAt: "2026-02-01T00:00:00Z", number: 1 };
  const c = { status: "in_implementation", statusChangedAt: "2026-01-01T00:00:00Z", number: 3 };
  assert.deepEqual([b, a, c].sort(compareBoardCards).map((x) => x.number), [3, 9, 1]);
  const i = (d: string, n: number) => ({ status: "implemented", statusChangedAt: d, number: n });
  assert.deepEqual(
    [i("2026-01-01T00:00:00Z", 5), i("2026-03-01T00:00:00Z", 2), i("2026-01-01T00:00:00Z", 7)].sort(compareBoardCards).map((x) => x.number),
    [2, 7, 5],
  );
});

test("time in stage: under a day, a negative difference, one day, several", () => {
  assert.equal(timeInStageText(new Date(NOW.getTime() - 23 * 60 * 60 * 1000), NOW), "Less than a day in this stage");
  assert.equal(timeInStageText(new Date(NOW.getTime() + 5 * 60 * 1000), NOW), "Less than a day in this stage");
  assert.equal(timeInStageText(new Date(NOW.getTime() - DAY), NOW), "1 day in this stage");
  assert.equal(timeInStageText(new Date(NOW.getTime() - 12.5 * DAY).toISOString(), NOW), "12 days in this stage");
});

test("the query parser: each filter, malformed ids and toggles, the first of a repeat, unknowns ignored", () => {
  const q = (s: string) => parseBoardQuery(new URLSearchParams(s));
  assert.deepEqual(q(""), { ok: true, value: { involving: false, following: false } });
  assert.deepEqual(q(`namespaceId=${ID}&impactAreaId=${ID}&topic=${ID}&involving=1&following=1&sort=x`), {
    ok: true,
    value: { namespaceId: ID, impactAreaId: ID, topicId: ID, involving: true, following: true },
  });
  for (const bad of ["namespaceId=abc", "namespaceId=", "impactAreaId=1", "topic=none", "involving=true", "following=0", "involving="]) {
    assert.equal(q(bad).ok, false, bad);
  }
  assert.deepEqual(q(`topic=${ID}&topic=nope`), { ok: true, value: { topicId: ID, involving: false, following: false } });
});

test("the page drops every malformed value before it reads, and writes back only what is set", () => {
  const { filters, dropped } = sanitizeBoardQuery(new URLSearchParams(`namespaceId=bad&topic=${ID}&involving=yes&following=1`));
  assert.deepEqual(filters, { topicId: ID, involving: false, following: true });
  assert.deepEqual(dropped.sort(), ["involving", "namespaceId"]);
  assert.equal(boardQueryString(filters), `topic=${ID}&following=1`);
  assert.equal(boardQueryString({ involving: false, following: false }), "");
});

test("long columns: Show more counts loaded cards; a moved card's place reveals whole pages", () => {
  assert.equal(showMoreCount(100, 30), 30);
  assert.equal(showMoreCount(100, 90), 10);
  assert.equal(showMoreCount(100, 100), 0);
  assert.equal(showMoreCount(12, 30), 0);
  assert.equal(showingToInclude(28, 30), 30); // in a column of 29: shown
  assert.equal(showingToInclude(29, 30), 30); // the 30th card: shown
  assert.equal(showingToInclude(30, 30), 60); // the 31st: revealed past the first 30
  assert.equal(showingToInclude(99, 30), 90 + 30);
  assert.equal(columnCapLine(140), "Showing 100 of 140. Use the filters to narrow the board.");
});

test("the confirmation's two wordings and the live-region texts", () => {
  assert.equal(
    implementedConfirmText("SOL-34", "CH-12", false),
    "Mark SOL-34 as implemented? This solves CH-12, closes its other open solutions as not selected and tells the people involved. It can't be undone from the board.",
  );
  assert.equal(
    implementedConfirmText(34, 12, true),
    "Mark SOL-34 as implemented? CH-12 is already solved. This closes its other open solutions as not selected and tells the people involved. It can't be undone from the board.",
  );
  assert.equal(movedAnnouncement("SOL-34", "In implementation"), "SOL-34 moved to In implementation.");
  assert.equal(movedAnnouncement("SOL-34", "In implementation", true), "SOL-34 moved to In implementation. It is below the first 100 cards of that column.");
  assert.equal(retiredTopicOption("Billing"), "Billing (retired)");
});

test("what the mover sees for each answer, and which re-read", () => {
  assert.deepEqual(classifyMoveAnswer(409), { refusal: "changed", reread: true });
  assert.deepEqual(classifyMoveAnswer(404), { refusal: "changed", reread: true });
  assert.deepEqual(classifyMoveAnswer(403), { refusal: "no_longer_yours", reread: true });
  assert.deepEqual(classifyMoveAnswer(422), { refusal: "no_longer_yours", reread: true });
  assert.deepEqual(classifyMoveAnswer(401), { refusal: "signed_out", reread: false });
  for (const s of [400, 429, 500, 503, 0]) assert.deepEqual(classifyMoveAnswer(s), { refusal: "not_saved", reread: false });
});

test("no board string carries a spec reference or names the organization", () => {
  for (const s of Object.values(BOARD_COPY)) assert.ok(!s.includes("§"), s);
});

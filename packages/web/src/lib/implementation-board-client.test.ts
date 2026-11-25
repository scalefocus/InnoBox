// Unit tests for the implementation board's page logic (INNOBOX_SPEC.md §46.7, §46.8): the local move,
// the put-back on a refusal, the 100-card cap, and the rule for which read answer is applied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { moveCardLocally, restoreCard, shouldApplyRead, withoutMoves, findCard, type BoardCardData, type BoardData } from "./implementation-board-client";

const card = (n: number, status: BoardCardData["status"], at: string): BoardCardData => ({
  number: `SOL-${n}`,
  status,
  statusChangedAt: at,
  author: { userId: null, displayName: "Anonymous", anonymous: true },
  authors: [{ userId: null, displayName: "Anonymous", anonymous: true }],
  likeCount: 0,
  moves: ["in_implementation"],
  moveMode: "enforced",
  challengeNumber: `CH-${n}`,
  challengeTitle: `Challenge ${n}`,
  challengeStatus: "valid",
  namespaceSlug: "global",
  impactAreaName: "Internal",
  topics: [],
  assigneeId: null,
  assigneeDisplayName: null,
  assigneeActive: null,
  assigneeScrubbed: null,
});

const board = (waiting: BoardCardData[], inImpl: BoardCardData[], implTotal = inImpl.length): BoardData => ({
  columns: [
    { status: "accepted_internally", total: 0, cards: [] },
    { status: "waiting_for_resources", total: waiting.length, cards: waiting },
    { status: "in_implementation", total: implTotal, cards: inImpl },
    { status: "external_acceptance", total: 0, cards: [] },
    { status: "implemented", total: 0, cards: [] },
  ],
  namespaces: [],
});

const NOW = new Date("2026-11-25T12:00:00Z");

test("a moved card lands at the bottom of an in-progress column, counted, with no moves", () => {
  const b = board([card(1, "waiting_for_resources", "2026-01-01T00:00:00Z")], [card(2, "in_implementation", "2026-02-01T00:00:00Z")]);
  const r = moveCardLocally(b, "SOL-1", "in_implementation", NOW)!;
  const col = r.board.columns.find((c) => c.status === "in_implementation")!;
  assert.deepEqual(col.cards.map((c) => c.number), ["SOL-2", "SOL-1"]);
  assert.equal(col.total, 2);
  assert.equal(r.board.columns.find((c) => c.status === "waiting_for_resources")!.total, 0);
  assert.equal(r.index, 1);
  assert.equal(r.beyondCap, false);
  assert.deepEqual(findCard(r.board, "SOL-1")!.moves, []);
  assert.equal(findCard(r.board, "SOL-1")!.moveMode, undefined);
});

test("a refused move goes back where it was, with its moves", () => {
  const b = board([card(1, "waiting_for_resources", "2026-01-01T00:00:00Z")], []);
  const r = moveCardLocally(b, "SOL-1", "in_implementation", NOW)!;
  const back = restoreCard(r.board, r.original);
  assert.deepEqual(back, b);
});

test("a card whose place is past the first 100 is counted and not drawn", () => {
  const full = Array.from({ length: 100 }, (_, i) => card(100 + i, "in_implementation", "2026-01-01T00:00:00Z"));
  const b = board([card(1, "waiting_for_resources", "2026-01-01T00:00:00Z")], full, 140);
  const r = moveCardLocally(b, "SOL-1", "in_implementation", NOW)!;
  const col = r.board.columns.find((c) => c.status === "in_implementation")!;
  assert.equal(r.beyondCap, true);
  assert.equal(col.cards.length, 100);
  assert.equal(col.total, 141);
  assert.equal(findCard(r.board, "SOL-1"), undefined);
});

test("an unknown card moves nowhere; withoutMoves strips one card's menu", () => {
  const b = board([card(1, "waiting_for_resources", "2026-01-01T00:00:00Z")], []);
  assert.equal(moveCardLocally(b, "SOL-9", "implemented", NOW), null);
  assert.deepEqual(findCard(withoutMoves(b, "SOL-1"), "SOL-1")!.moves, []);
});

test("only the latest read, sent after the last move and with nothing open, is applied", () => {
  const base = { readSeq: 3, latestReadSeq: 3, moveEpochAtSend: 2, moveEpochNow: 2, movesInFlight: 0, interacting: false };
  assert.equal(shouldApplyRead(base), true);
  assert.equal(shouldApplyRead({ ...base, latestReadSeq: 4 }), false, "an older read");
  assert.equal(shouldApplyRead({ ...base, moveEpochNow: 3 }), false, "a move was sent or answered since");
  assert.equal(shouldApplyRead({ ...base, movesInFlight: 1 }), false, "a move is in flight");
  assert.equal(shouldApplyRead({ ...base, interacting: true }), false, "a drag, menu or confirmation is open");
});

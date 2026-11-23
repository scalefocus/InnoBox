// Unit tests for the innovation board's pure half (INNOBOX_SPEC.md §45): the limits, the add
// request's validation and the copy. The §4.3 exemption itself is tested with the visibility
// predicates (challenges.test.ts), the digest class of events 1 and 2 with the digest (email-digest.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOARD_ADDED_SUBJECT,
  BOARD_FULL,
  BOARD_PROFILE_LINE,
  INNOVATION_BOARD_ADD_MAX,
  INNOVATION_BOARD_MAX,
  boardAddedEmailText,
  boardAddedMessage,
  boardChallengeSubmittedMessage,
  boardFormNote,
  boardRemoveConfirm,
  validateBoardUserIds,
} from "./innovation-board.js";
import { NOTIFICATION_TYPES } from "./social.js";

const id = (n: number): string => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

test("the limits: 100 on the board, 20 per add (§45.2)", () => {
  assert.equal(INNOVATION_BOARD_MAX, 100);
  assert.equal(INNOVATION_BOARD_ADD_MAX, 20);
  assert.equal(BOARD_FULL, "The innovation board can have at most 100 members.");
});

test("validateBoardUserIds: 1 to 20 distinct user ids, lower-cased", () => {
  assert.deepEqual(validateBoardUserIds([id(1)]), { ok: true, value: [id(1)] });
  assert.deepEqual(validateBoardUserIds(["AAAAAAAA-0000-4000-8000-00000000000A"]), { ok: true, value: ["aaaaaaaa-0000-4000-8000-00000000000a"] });
  const twenty = Array.from({ length: INNOVATION_BOARD_ADD_MAX }, (_, i) => id(i + 1));
  assert.equal(validateBoardUserIds(twenty).ok, true);
  assert.equal(validateBoardUserIds([...twenty, id(99)]).ok, false, "the 21st is refused");
});

test("validateBoardUserIds: anything else is a malformed body", () => {
  for (const bad of [undefined, null, "x", {}, [], [1], ["not-a-uuid"], [id(1), null], [id(1), id(1)], [id(1), id(1).toUpperCase()]]) {
    assert.equal(validateBoardUserIds(bad).ok, false, JSON.stringify(bad));
  }
});

test("event 1 as the board reads it: submitted, not 'needs triage', and no author (§45.5)", () => {
  assert.equal(boardChallengeSubmittedMessage("CH-412", "Reduce invoice matching time"), 'New challenge CH-412 "Reduce invoice matching time" was submitted.');
  assert.equal(boardChallengeSubmittedMessage(412, "T"), 'New challenge CH-412 "T" was submitted.');
  assert.doesNotMatch(boardChallengeSubmittedMessage("412", "T"), /triage/);
});

test("event 28: the inbox line, the subject and the e-mail body (§45.6)", () => {
  assert.equal(boardAddedMessage("Ana Petrova"), "Ana Petrova added you to the innovation board. You'll hear about every new challenge and solution.");
  assert.equal(BOARD_ADDED_SUBJECT, "You've been added to the innovation board");
  const body = boardAddedEmailText("Ana Petrova");
  assert.match(body, /^Ana Petrova added you to the innovation board\./);
  assert.match(body, /before they are reviewed/);
  assert.match(body, /e-mail delivery choice/);
  assert.ok(NOTIFICATION_TYPES.includes("innovation_board_added"));
});

test("the submit forms' line: one wording for an org item, a narrower one per form for a restricted item (§45.7)", () => {
  assert.equal(boardFormNote("challenge", false), "The innovation board can read this before it's reviewed.");
  assert.equal(boardFormNote("solution", false), "The innovation board can read this before it's reviewed.");
  assert.equal(boardFormNote("challenge", true), "Innovation board members in this namespace can read this before it's reviewed.");
  assert.equal(boardFormNote("solution", true), "Innovation board members who can see this challenge can read this before it's reviewed.");
});

test("no line of board copy carries a spec reference (§21.9)", () => {
  const copy = [
    BOARD_FULL,
    BOARD_PROFILE_LINE,
    BOARD_ADDED_SUBJECT,
    boardAddedMessage("A"),
    boardAddedEmailText("A"),
    boardChallengeSubmittedMessage(1, "T"),
    boardFormNote("challenge", true),
    boardFormNote("solution", true),
    boardRemoveConfirm("A"),
  ];
  for (const line of copy) assert.doesNotMatch(line, /§/);
  assert.match(boardRemoveConfirm("Ana Petrova"), /^Remove Ana Petrova from the innovation board\?/);
});

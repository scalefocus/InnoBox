// §40 invite a solver — the pure rules: the request parser (400 vs 422), the caps in their refusal
// order, the room left, the UTC day, the "answered" rule behind the banner, and the copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INVITATION_MESSAGES,
  INVITES_PER_CHALLENGE,
  INVITES_PER_DAY,
  INVITE_NOTE_MAX,
  inboxNote,
  invitationBannerHeadline,
  invitationCapRefusal,
  invitationMessage,
  invitationPaidOffMessage,
  invitationRoom,
  invitationSubject,
  invitationsSentToast,
  isAnswered,
  normalizeInviteNote,
  parseInvitationRequest,
  sendInvitationsLabel,
  utcDayStart,
} from "./invitations.js";
import { isDigestableEvent } from "./email-digest.js";
import { awardKey, badgeTiersReached, pointsFor } from "./gamification.js";

const A = "11111111-1111-4111-8111-111111111111";
const ids = (n: number) => Array.from({ length: n }, (_, i) => `0000000${i}-0000-4000-8000-000000000000`);

test("the caps and the note limit are fixed in code", () => {
  assert.equal(INVITES_PER_CHALLENGE, 5);
  assert.equal(INVITES_PER_DAY, 20);
  assert.equal(INVITE_NOTE_MAX, 500);
});

test("parseInvitationRequest: 1–5 distinct ids, lower-cased; anything else is a 400", () => {
  assert.deepEqual(parseInvitationRequest({ userIds: [A.toUpperCase()] }), { ok: true, value: { userIds: [A], note: null } });
  assert.deepEqual(parseInvitationRequest({ userIds: ids(5) }).ok, true, "five is the most one request names");
  for (const userIds of [undefined, [], ids(6), ["not-a-uuid"], [A, A], A]) {
    const r = parseInvitationRequest({ userIds });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  }
});

test("parseInvitationRequest: the note is trimmed, empty means none, over 500 is a 422", () => {
  const r = parseInvitationRequest({ userIds: [A], note: "  Right up your street.  " });
  assert.ok(r.ok && r.value.note === "Right up your street.");
  const blank = parseInvitationRequest({ userIds: [A], note: "   \n " });
  assert.ok(blank.ok && blank.value.note === null, "whitespace only is no note");
  const exact = parseInvitationRequest({ userIds: [A], note: ` ${"x".repeat(500)} ` });
  assert.ok(exact.ok && exact.value.note?.length === 500, "500 after trimming is allowed");
  const long = parseInvitationRequest({ userIds: [A], note: "x".repeat(501) });
  assert.deepEqual(long, { ok: false, status: 422, error: INVITATION_MESSAGES.noteTooLong });
  const wrong = parseInvitationRequest({ userIds: [A], note: 42 });
  assert.ok(!wrong.ok && wrong.status === 400);
  assert.equal(normalizeInviteNote("\tline one\nline two "), "line one\nline two", "line breaks inside are kept");
});

test("invitationCapRefusal: the 5th on a challenge and the 20th of a day fit, the next do not — the challenge cap first", () => {
  assert.equal(invitationCapRefusal(1, 4, 0), null, "the fifth on a challenge");
  assert.equal(invitationCapRefusal(1, 5, 0), "challenge_cap", "the sixth");
  assert.equal(invitationCapRefusal(2, 4, 0), "challenge_cap", "a request that would pass the cap");
  assert.equal(invitationCapRefusal(1, 0, 19), null, "the twentieth of a day");
  assert.equal(invitationCapRefusal(1, 0, 20), "daily_cap", "the twenty-first");
  assert.equal(invitationCapRefusal(3, 5, 20), "challenge_cap", "both over: the per-challenge cap is reported");
});

test("invitationRoom: what is left on the challenge and today, never below zero", () => {
  assert.deepEqual(invitationRoom(0, 0), { left: 5, leftToday: 20 });
  assert.deepEqual(invitationRoom(3, 18), { left: 2, leftToday: 2 });
  assert.deepEqual(invitationRoom(7, 25), { left: 0, leftToday: 0 });
});

test("utcDayStart: the daily cap starts at 00:00:00 UTC, whatever the local time", () => {
  assert.equal(utcDayStart(new Date("2026-10-28T23:59:59.999Z")).toISOString(), "2026-10-28T00:00:00.000Z");
  assert.equal(utcDayStart(new Date("2026-10-29T00:00:00.000Z")).toISOString(), "2026-10-29T00:00:00.000Z");
});

test("isAnswered: only a solution created after the invitation answers it", () => {
  const invited = new Date("2026-10-28T10:00:00Z");
  assert.equal(isAnswered(invited, []), false);
  assert.equal(isAnswered(invited, [new Date("2026-10-27T10:00:00Z")]), false, "an earlier solution does not");
  assert.equal(isAnswered(invited, [invited]), false, "nor one at the same instant");
  assert.equal(isAnswered(invited, [new Date("2026-10-27T10:00:00Z"), new Date("2026-10-28T10:00:01Z")]), true);
});

test("copy: event 22 names the inviter and the challenge, never its author", () => {
  assert.equal(invitationMessage("Ana Petrova", "412", "Reduce invoice matching time"), 'Ana Petrova invited you to propose a solution to CH-412 "Reduce invoice matching time".');
  assert.equal(invitationSubject("Ana Petrova", 412), "Ana Petrova invited you to propose a solution to CH-412");
  assert.equal(inboxNote("short"), "short");
  const cut = inboxNote("y".repeat(300));
  assert.equal(cut.length, 200);
  assert.ok(cut.endsWith("…"));
  assert.equal(inboxNote("two\n\nlines"), "two lines", "the bell's line is flat");
});

test("copy: event 23, the banner headline, the button and the toast", () => {
  assert.equal(invitationPaidOffMessage("Bob Ivanov", "34", "412"), "Bob Ivanov answered your invitation with SOL-34 on CH-412.");
  assert.equal(invitationBannerHeadline([]), "");
  assert.equal(invitationBannerHeadline(["Ana Petrova"]), "Ana Petrova invited you to propose a solution.");
  assert.equal(invitationBannerHeadline(["Ana Petrova", "Bob"]), "Ana Petrova and 1 other invited you to propose a solution.");
  assert.equal(invitationBannerHeadline(["Ana Petrova", "Bob", "Cy"]), "Ana Petrova and 2 others invited you to propose a solution.");
  assert.equal(sendInvitationsLabel(1), "Send invitation");
  assert.equal(sendInvitationsLabel(3), "Send 3 invitations");
  assert.equal(invitationsSentToast(1), "Invitation sent");
  assert.equal(invitationsSentToast(4), "4 invitations sent");
});

test("events 22 and 23 are never held for a digest", () => {
  assert.equal(isDigestableEvent(22), false, "event 22 is actionable");
  assert.equal(isDigestableEvent(23), false, "event 23 has no e-mail");
});

test("Matchmaker: a 0-point marker per (challenge, invitee, inviter), tiered 1 / 5 / 20", () => {
  assert.equal(awardKey.inviteFulfilled("c1", "bob", "ana"), "invite_fulfilled:c1:bob:ana");
  assert.equal(pointsFor("invite_fulfilled", 0), 0, "giving never earns points");
  const tiers = (n: number) => badgeTiersReached({ invite_fulfilled: n }).filter((r) => r.badgeKey === "matchmaker").map((r) => r.tier);
  assert.deepEqual(tiers(0), []);
  assert.deepEqual(tiers(1), [1]);
  assert.deepEqual(tiers(5), [1, 2]);
  assert.deepEqual(tiers(20), [1, 2, 3]);
});

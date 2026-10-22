// Unit tests for the §12.1 e-mail digests: which events a digest may hold, the send-slot
// calculation (daily and weekly, around 06:00 UTC and on Mondays), the grouping and copy, and
// the 25-item cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIGEST_MAX_ITEMS,
  isDigestableEvent,
  isEmailDelivery,
  nextDigestSlot,
  renderDigest,
  type DigestUpdate,
  type NotificationEventNumber,
} from "./email-digest.js";
import { parsePreferencePatch } from "./notification-preferences.js";

const ALL_EVENTS: NotificationEventNumber[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];

test("only the follower-type events (2, 3, 6, 8), hyped (16) and a new challenge in a followed topic (18) are digestable", () => {
  assert.deepEqual(
    ALL_EVENTS.filter((e) => isDigestableEvent(e)),
    [2, 3, 6, 8, 16, 18],
  );
});

test("renderDigest: a challenge new in a followed topic leads its block, topics merged and sorted (§34.5)", () => {
  const digest = renderDigest(
    [
      update({ kind: "comment", count: 2 }),
      update({ kind: "topic", topics: ["Automation"] }),
      update({ kind: "topic", topics: ["AI", "Automation"] }),
    ],
    "daily",
    "https://x.test",
  );
  assert.ok(digest);
  assert.equal(
    digest!.text.split("\n\n")[1],
    ["CH-412 — Faster onboarding", "https://x.test/challenges/412", "- New in a topic you follow — AI, Automation", "- 2 new comments"].join("\n"),
  );
});

test("a recipient on the admin route is never held — event 2 to admins and the committee stays immediate", () => {
  assert.equal(isDigestableEvent(2, true), false);
  assert.equal(isDigestableEvent(2, false), true);
  assert.deepEqual(
    ALL_EVENTS.filter((e) => isDigestableEvent(e, true)),
    [],
  );
});

test("the admin attention and actionable events are never held", () => {
  for (const e of [1, 4, 5, 7, 9, 10, 11, 12, 13, 14] as const) assert.equal(isDigestableEvent(e), false, `event ${e}`);
});

test("renderDigest: hypes get one line per item — the challenge's first, then each solution's (§26.6)", () => {
  const digest = renderDigest(
    [
      update({ kind: "hype", count: 3, solutionNumber: "17" }),
      update({ kind: "hype", count: 1 }),
      update({ kind: "hype", count: 2, solutionNumber: "17" }),
    ],
    "daily",
    "https://x.test",
  );
  assert.ok(digest);
  const lines = digest!.text.split(/\r?\n/);
  const own = lines.findIndex((l) => l.includes("1 new hype") && !l.includes("SOL-"));
  const sol = lines.findIndex((l) => l.includes("SOL-17: 5 new hypes"));
  assert.ok(own >= 0, digest!.text);
  assert.ok(sol > own, "the challenge's own line comes first");
});

test("isEmailDelivery accepts the three modes only", () => {
  assert.equal(isEmailDelivery("immediate"), true);
  assert.equal(isEmailDelivery("daily"), true);
  assert.equal(isEmailDelivery("weekly"), true);
  assert.equal(isEmailDelivery("hourly"), false);
  assert.equal(isEmailDelivery(1), false);
});

const at = (iso: string) => new Date(iso);

test("daily slot: today at 06:00 UTC before it, tomorrow at or after it", () => {
  assert.equal(nextDigestSlot("daily", at("2026-10-13T05:59:59.999Z")).toISOString(), "2026-10-13T06:00:00.000Z");
  assert.equal(nextDigestSlot("daily", at("2026-10-13T06:00:00.000Z")).toISOString(), "2026-10-14T06:00:00.000Z", "06:00 exactly waits a day");
  assert.equal(nextDigestSlot("daily", at("2026-10-13T06:00:01Z")).toISOString(), "2026-10-14T06:00:00.000Z");
  assert.equal(nextDigestSlot("daily", at("2026-12-31T23:30:00Z")).toISOString(), "2027-01-01T06:00:00.000Z", "across a year end");
});

test("weekly slot: the next Monday at 06:00 UTC", () => {
  // 2026-10-12 is a Monday.
  assert.equal(nextDigestSlot("weekly", at("2026-10-12T05:00:00Z")).toISOString(), "2026-10-12T06:00:00.000Z", "Monday before the slot");
  assert.equal(
    nextDigestSlot("weekly", at("2026-10-12T06:00:01Z")).toISOString(),
    "2026-10-19T06:00:00.000Z",
    "a write just after 06:00 UTC on a Monday waits a whole week",
  );
  assert.equal(nextDigestSlot("weekly", at("2026-10-13T10:00:00Z")).toISOString(), "2026-10-19T06:00:00.000Z", "Tuesday");
  assert.equal(nextDigestSlot("weekly", at("2026-10-18T23:59:00Z")).toISOString(), "2026-10-19T06:00:00.000Z", "Sunday night");
});

const update = (over: Partial<DigestUpdate>): DigestUpdate => ({
  kind: "status",
  challengeNumber: "412",
  challengeTitle: "Faster onboarding",
  count: 1,
  at: at("2026-10-12T10:00:00Z"),
  ...over,
});

test("renderDigest: nothing to send → null", () => {
  assert.equal(renderDigest([], "daily", "https://innobox.example.com"), null);
});

test("renderDigest groups by challenge, most recently active first, one line per kind", () => {
  const digest = renderDigest(
    [
      update({ kind: "status", statusLabel: "Valid — open for solutions", at: at("2026-10-12T08:00:00Z") }),
      update({ kind: "status", statusLabel: "In review", at: at("2026-10-12T07:00:00Z") }),
      update({ kind: "comment", count: 5, at: at("2026-10-12T09:00:00Z") }),
      update({ kind: "solution" }),
      update({ kind: "status", solutionNumber: "17", statusLabel: "Valid", at: at("2026-10-12T06:30:00Z") }),
      update({ challengeNumber: "CH-9", challengeTitle: "Older item", kind: "implemented", solutionNumber: "SOL-3", at: at("2026-10-11T10:00:00Z") }),
    ],
    "daily",
    "https://innobox.example.com/",
  );
  assert.ok(digest);
  assert.equal(digest.subject, "Your daily InnoBox digest — 10 updates");
  assert.equal(digest.itemCount, 2);
  assert.equal(
    digest.text,
    [
      "Here is your daily summary of what happened on the items you follow.",
      [
        "CH-412 — Faster onboarding",
        "https://innobox.example.com/challenges/412",
        "- 1 new solution",
        "- 2 status changes — now Valid — open for solutions",
        "- SOL-17: 1 status change — now Valid",
        "- 5 new comments",
      ].join("\n"),
      ["CH-9 — Older item", "https://innobox.example.com/challenges/9", "- Solution SOL-3 was implemented"].join("\n"),
    ].join("\n\n"),
  );
});

test("renderDigest: weekly wording, singular counts, an implemented line without a number", () => {
  const digest = renderDigest([update({ kind: "implemented", solutionNumber: null })], "weekly", "https://x.test");
  assert.ok(digest);
  assert.equal(digest.subject, "Your weekly InnoBox digest — 1 update");
  assert.match(digest.text, /^Here is your weekly summary/);
  assert.match(digest.text, /- A solution was implemented/);
});

test("renderDigest: the one-off release digest (switch back to immediate) names no cadence", () => {
  const digest = renderDigest([update({ kind: "comment" })], null, "https://x.test");
  assert.ok(digest);
  assert.equal(digest.subject, "Your InnoBox digest — 1 update");
  assert.match(digest.text, /- 1 new comment$/);
});

test("renderDigest names no author and keeps a title on one line", () => {
  const digest = renderDigest([update({ challengeTitle: "Line one\nLine two" })], "daily", "https://x.test");
  assert.ok(digest);
  assert.match(digest.text, /CH-412 — Line one Line two\n/);
});

test("renderDigest lists at most 25 items, then one 'and K more' line", () => {
  const updates = Array.from({ length: DIGEST_MAX_ITEMS + 3 }, (_, i) =>
    update({ challengeNumber: String(i + 1), challengeTitle: `Item ${i + 1}`, at: new Date(Date.UTC(2026, 9, 12, 0, i)) }),
  );
  const digest = renderDigest(updates, "daily", "https://x.test");
  assert.ok(digest);
  assert.equal(digest.itemCount, DIGEST_MAX_ITEMS + 3);
  assert.equal((digest.text.match(/^CH-\d+ — /gm) ?? []).length, DIGEST_MAX_ITEMS);
  assert.match(digest.text, /CH-28 — Item 28/, "the most recent item leads");
  assert.doesNotMatch(digest.text, /CH-1 — Item 1\n/, "the oldest falls past the cap");
  assert.match(digest.text, /and 3 more — open InnoBox to see everything\nhttps:\/\/x\.test\/$/);
  assert.equal(digest.subject, "Your daily InnoBox digest — 28 updates", "the count covers every update, listed or not");
});

test("parsePreferencePatch accepts the delivery choice and refuses an unknown one", () => {
  assert.deepEqual(parsePreferencePatch({ emailDelivery: "weekly" }), { ok: true, value: { emailDelivery: "weekly" } });
  assert.deepEqual(parsePreferencePatch({ emailDelivery: "hourly" }), { ok: false, error: "emailDelivery must be one of immediate, daily, weekly" });
});

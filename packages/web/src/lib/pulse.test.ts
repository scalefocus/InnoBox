// Unit tests for the §12.2 pulse helpers (INNOBOX_SPEC.md §12.2, v1.18): response parsing, the
// "no needless re-render" equality, the visibility catch-up rule and the failure handling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_PULSE, PULSE_INTERVAL_MS, PULSE_REFRESH_EVENTS, parsePulse, pulseOutcome, samePulse, shouldPollOnVisible, type Pulse } from "./pulse";

const banner = { message: "Maintenance tonight", tone: "info", url: null, expiresAt: "2026-10-22T18:00:00.000Z" } as Pulse["banner"];

test("parsePulse reads the four values the route returns", () => {
  assert.deepEqual(parsePulse({ unreadCount: 3, newChallenges: 5, attention: 2, banner }), { unreadCount: 3, newChallenges: 5, attention: 2, banner });
});

test("parsePulse keeps a non-admin's attention null — the key is present, the value is null", () => {
  assert.equal(parsePulse({ unreadCount: 0, newChallenges: 0, attention: null, banner: null }).attention, null);
  assert.equal(parsePulse({ unreadCount: 0, newChallenges: 0, banner: null }).attention, null);
});

test("parsePulse degrades malformed input to nothing-to-show, never to a crash or a negative bubble", () => {
  assert.deepEqual(parsePulse(null), EMPTY_PULSE);
  assert.deepEqual(parsePulse("nope"), EMPTY_PULSE);
  assert.deepEqual(parsePulse({ unreadCount: -4, newChallenges: "7", attention: Number.NaN, banner: { message: 1 } }), {
    unreadCount: 0,
    newChallenges: 0,
    attention: 0,
    banner: null,
  });
  assert.equal(parsePulse({ unreadCount: 2.9 }).unreadCount, 2);
});

test("samePulse: identical values are the same pulse, so an idle tick keeps the previous state", () => {
  const a: Pulse = { unreadCount: 1, newChallenges: 2, attention: null, banner };
  assert.equal(samePulse(a, { ...a, banner: banner && { ...banner } }), true);
  assert.equal(samePulse(EMPTY_PULSE, { ...EMPTY_PULSE }), true);
});

test("samePulse: any change in a count, the attention role or the banner is a new pulse", () => {
  const a: Pulse = { unreadCount: 1, newChallenges: 2, attention: 0, banner };
  assert.equal(samePulse(a, { ...a, unreadCount: 2 }), false);
  assert.equal(samePulse(a, { ...a, newChallenges: 3 }), false);
  assert.equal(samePulse(a, { ...a, attention: null }), false, "0 (an admin with nothing unseen) is not null (not an admin)");
  assert.equal(samePulse(a, { ...a, banner: null }), false);
  assert.equal(samePulse(a, { ...a, banner: banner && { ...banner, expiresAt: "2026-10-23T18:00:00.000Z" } }), false, "a replaced banner");
});

test("shouldPollOnVisible: a returning tab catches up at once only when its last pulse is stale", () => {
  const now = 1_000_000;
  assert.equal(shouldPollOnVisible(null, now), true, "never polled");
  assert.equal(shouldPollOnVisible(now - PULSE_INTERVAL_MS, now), true, "exactly one interval old");
  assert.equal(shouldPollOnVisible(now - 5 * 60_000, now), true, "hidden for minutes");
  assert.equal(shouldPollOnVisible(now - 5_000, now), false, "a quick tab switch does not double-poll");
});

test("pulseOutcome: 2xx applies, 401 stops polling, anything else keeps the last values", () => {
  assert.equal(pulseOutcome(200), "apply");
  assert.equal(pulseOutcome(401), "stop");
  assert.equal(pulseOutcome(403), "keep");
  assert.equal(pulseOutcome(429), "keep");
  assert.equal(pulseOutcome(500), "keep");
});

test("the immediate-refresh events cover mark-read, the banner card, the triage queue and leaving Challenges", () => {
  assert.deepEqual([...PULSE_REFRESH_EVENTS].sort(), ["innobox:banner-changed", "innobox:challenges-seen", "innobox:pulse", "innobox:triage-seen"]);
  assert.equal(PULSE_INTERVAL_MS, 30_000);
});

// Unit tests for the §12.1 per-event preferences: the mute keeps exempt recipients and order, and
// the PATCH parser accepts any subset of the toggles and the e-mail switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NOTIFICATION_PREFERENCE_COLUMN, applyPreferenceMute, isNotificationPreference, parsePreferencePatch } from "./notification-preferences.js";

test("applyPreferenceMute drops opted-out recipients but never an exempt one", () => {
  assert.deepEqual(applyPreferenceMute(["a", "b", "c", "d"], new Set(["b", "d"])), ["a", "c"]);
  assert.deepEqual(applyPreferenceMute(["a", "b", "c"], new Set(["a", "b"]), new Set(["a"])), ["a", "c"], "an exempt admin keeps the event");
  assert.deepEqual(applyPreferenceMute([], new Set(["a"])), []);
  assert.deepEqual(applyPreferenceMute(["x"], new Set()), ["x"]);
});

test("the column map is fixed and complete", () => {
  assert.deepEqual(NOTIFICATION_PREFERENCE_COLUMN, {
    followedComments: "notify_followed_comments",
    followedStatus: "notify_followed_status",
    followedSolutions: "notify_followed_solutions",
  });
  assert.equal(isNotificationPreference("followedStatus"), true);
  assert.equal(isNotificationPreference("emailNotificationsEnabled"), false);
});

test("parsePreferencePatch accepts any subset of booleans and refuses the rest", () => {
  assert.deepEqual(parsePreferencePatch({ followedComments: false }), { ok: true, value: { followedComments: false } });
  assert.deepEqual(parsePreferencePatch({ emailNotificationsEnabled: true, followedStatus: false, junk: 1 }), {
    ok: true,
    value: { emailNotificationsEnabled: true, followedStatus: false },
  });
  assert.equal(parsePreferencePatch({}).ok, false, "nothing recognised");
  assert.equal(parsePreferencePatch({ followedSolutions: "no" }).ok, false, "not a boolean");
  assert.equal(parsePreferencePatch(null).ok, false);
  assert.equal(parsePreferencePatch([true]).ok, false);
});

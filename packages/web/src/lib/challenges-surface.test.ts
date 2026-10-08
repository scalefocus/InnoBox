// Unit tests for the §13.1 Challenges-surface matcher behind the new-since-last-visit marker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isChallengesSurface, leavesChallengesSurface } from "./challenges-surface";

test("the gallery and its detail pages are the surface; the submission form is not", () => {
  assert.equal(isChallengesSurface("/challenges"), true);
  assert.equal(isChallengesSurface("/challenges/412"), true);
  assert.equal(isChallengesSurface("/challenges/412/"), true);
  assert.equal(isChallengesSurface("/challenges/CH-412"), true);
  assert.equal(isChallengesSurface("/challenges/new"), false);
  assert.equal(isChallengesSurface("/challenges/412/edit"), false);
  assert.equal(isChallengesSurface("/"), false);
  assert.equal(isChallengesSurface("/leaderboard"), false);
  assert.equal(isChallengesSurface(null), false);
  assert.equal(isChallengesSurface(undefined), false);
});

test("the marker advances only when leaving the surface", () => {
  assert.equal(leavesChallengesSurface("/challenges", "/"), true);
  assert.equal(leavesChallengesSurface("/challenges/7", "/leaderboard"), true);
  assert.equal(leavesChallengesSurface("/challenges", "/challenges/7"), false, "gallery → detail stays on the surface");
  assert.equal(leavesChallengesSurface("/challenges/7", "/challenges"), false, "detail → gallery stays on the surface");
  assert.equal(leavesChallengesSurface("/", "/challenges"), false, "entering is not leaving");
  assert.equal(leavesChallengesSurface("/challenges", "/challenges/new"), true, "the form is off the surface");
  assert.equal(leavesChallengesSurface(null, "/"), false);
});

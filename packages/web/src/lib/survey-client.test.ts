// Unit tests for the survey's browser-side `canShow` rule (INNOBOX_SPEC.md §13.10): every blocking
// state alone keeps the survey off screen, and What's new always wins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reportFeatureUse, reportedKey, subscribeFeatureUse, surveyCanShow, type CanShowState } from "./survey-client";

const clear: CanShowState = { shellReady: true, whatsNewDue: false, quickStartGate: false, cardOpen: false, mobileOverlayOpen: false };

test("canShow: true only when nothing blocks", () => {
  assert.equal(surveyCanShow(clear), true);
  assert.equal(surveyCanShow({ ...clear, shellReady: false }), false, "before the shell's decision");
  assert.equal(surveyCanShow({ ...clear, whatsNewDue: true }), false, "What's new always wins");
  assert.equal(surveyCanShow({ ...clear, quickStartGate: true }), false, "the Quick start gate");
  assert.equal(surveyCanShow({ ...clear, cardOpen: true }), false, "a card already open in this tab");
  assert.equal(surveyCanShow({ ...clear, mobileOverlayOpen: true }), false, "the mobile drawer or sheet");
});

test("the session dedupe key is per feature", () => {
  assert.notEqual(reportedKey("search"), reportedKey("like"));
  assert.match(reportedKey("search"), /search$/);
});

test("reports made before the shell subscribes are handed over when it does — none are lost", () => {
  reportFeatureUse("leaderboard"); // a page effect that ran before the shell's
  reportFeatureUse("leaderboard");
  const seen: string[] = [];
  const unsubscribe = subscribeFeatureUse((f) => seen.push(f));
  assert.deepEqual(seen, ["leaderboard"], "queued once per feature, delivered on subscribe");
  reportFeatureUse("search");
  assert.deepEqual(seen, ["leaderboard", "search"], "later reports go straight through");
  unsubscribe();
  reportFeatureUse("like");
  assert.deepEqual(seen, ["leaderboard", "search"]);
  subscribeFeatureUse((f) => seen.push(f))();
  assert.deepEqual(seen, ["leaderboard", "search", "like"]);
});

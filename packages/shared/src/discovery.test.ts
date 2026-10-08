import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeCsvField, isDateFormat, isLeaderboardMetric, isLeaderboardWindow, toCsvRow } from "./discovery.js";

test("isDateFormat: accepts eu/us, rejects anything else", () => {
  assert.equal(isDateFormat("eu"), true);
  assert.equal(isDateFormat("us"), true);
  assert.equal(isDateFormat("EU"), false);
  assert.equal(isDateFormat("iso"), false);
});

test("isLeaderboardMetric / isLeaderboardWindow: accept only the documented vocab", () => {
  assert.equal(isLeaderboardMetric("solutions_implemented"), true);
  assert.equal(isLeaderboardMetric("likes_received"), true);
  assert.equal(isLeaderboardMetric("bogus"), false);
  assert.equal(isLeaderboardWindow("30d"), true);
  assert.equal(isLeaderboardWindow("all"), true);
  assert.equal(isLeaderboardWindow("7d"), false);
});

test("escapeCsvField: plain values pass through untouched", () => {
  assert.equal(escapeCsvField("CH-12"), "CH-12");
  assert.equal(escapeCsvField("Anonymous"), "Anonymous");
});

test("escapeCsvField: quotes values containing commas, quotes, or newlines; doubles embedded quotes", () => {
  assert.equal(escapeCsvField("a,b"), '"a,b"');
  assert.equal(escapeCsvField('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvField("line1\nline2"), '"line1\nline2"');
});

test("toCsvRow: joins escaped fields with commas, coercing numbers to strings", () => {
  assert.equal(toCsvRow(["CH-1", "Title, with comma", 3]), 'CH-1,"Title, with comma",3');
});

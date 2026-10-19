import { test } from "node:test";
import assert from "node:assert/strict";
import {
  escapeCsvField,
  isDateFormat,
  isLeaderboardMetric,
  isLeaderboardWindow,
  neutralizeCsvFormula,
  toCsvRow,
} from "./discovery.js";

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

test("neutralizeCsvFormula: prefixes a quote to every formula trigger, leaves the rest", () => {
  for (const trigger of ["=", "+", "-", "@", "|", "\t", "\r"]) {
    assert.equal(neutralizeCsvFormula(`${trigger}x`), `'${trigger}x`, JSON.stringify(trigger));
  }
  assert.equal(neutralizeCsvFormula("|cmd"), "'|cmd", "the legacy DDE trigger");
  assert.equal(neutralizeCsvFormula("=x"), "'=x");
  assert.equal(neutralizeCsvFormula("Reduce costs"), "Reduce costs");
  assert.equal(neutralizeCsvFormula("normal"), "normal");
  assert.equal(neutralizeCsvFormula("a=b"), "a=b"); // only the leading character matters
  assert.equal(neutralizeCsvFormula(""), "");
});

test("neutralizeCsvFormula: leading whitespace before a trigger is neutralized too; whitespace before plain text is not", () => {
  // Some applications trim first, then evaluate — so the trigger after whitespace counts.
  assert.equal(neutralizeCsvFormula(" =1"), "' =1");
  assert.equal(neutralizeCsvFormula("  =1"), "'  =1");
  assert.equal(neutralizeCsvFormula("\t=1"), "'\t=1");
  assert.equal(neutralizeCsvFormula("   |cmd"), "'   |cmd");
  assert.equal(neutralizeCsvFormula(" -1"), "' -1", "non-breaking space is whitespace too");
  assert.equal(neutralizeCsvFormula(" text"), " text");
  assert.equal(neutralizeCsvFormula("   "), "   ", "whitespace alone is not a formula");
  assert.equal(neutralizeCsvFormula("a |b"), "a |b");
});

test("escapeCsvField: neutralizes formulas before RFC 4180 quoting", () => {
  assert.equal(escapeCsvField("=HYPERLINK(\"http://x\",\"y\")"), '"\'=HYPERLINK(""http://x"",""y"")"');
  assert.equal(escapeCsvField("=1+2"), "'=1+2");
  assert.equal(escapeCsvField("- Reduce costs"), "'- Reduce costs");
  assert.equal(escapeCsvField("@SUM(A1),x"), "\"'@SUM(A1),x\"");
  // A leading CR both triggers neutralization and forces quoting.
  assert.equal(escapeCsvField("\r=1"), "\"'\r=1\"");
  assert.equal(escapeCsvField("\tcmd"), "'\tcmd");
});

test("toCsvRow: neutralization applies to every cell, header included", () => {
  assert.equal(toCsvRow(["=Number", "+Title", -3]), "'=Number,'+Title,'-3");
});

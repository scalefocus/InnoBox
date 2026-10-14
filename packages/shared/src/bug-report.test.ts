// Unit tests for the §13.10 bug-report rules: the gate, the picker, validation, the page-path
// sanitizer and the bug-button click decision (cases 1–4).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUG_PAGE_PATH_MAX,
  BUG_PICKER_VALUE,
  SURVEY_FEATURES,
  SURVEY_FREE_TEXT_MAX,
  SURVEY_RESPONSE_TRIGGERS,
  SURVEY_TRIGGERS,
  bugButtonVisible,
  bugClickDecision,
  bugReportsOn,
  parseStoredOffer,
  sanitizeBugPagePath,
  surveyPickerOptions,
  validateBugReport,
} from "./survey.js";

const NOW = new Date("2026-10-14T12:00:00Z");

test("bug reports need both platform switches — the survey switch is the master", () => {
  assert.equal(bugReportsOn(true, true), true);
  assert.equal(bugReportsOn(true, false), false);
  assert.equal(bugReportsOn(false, true), false);
  assert.equal(bugReportsOn(false, false), false);
});

test("the bug button: signed in, past Quick start, bug reports on — the random opt-out is no input", () => {
  const base = { shellReady: true, quickStartGate: false, quickStartSeen: true, bugReports: true };
  assert.equal(bugButtonVisible(base), true);
  assert.equal(bugButtonVisible({ ...base, shellReady: false }), false, "signed out or still loading");
  assert.equal(bugButtonVisible({ ...base, quickStartSeen: false }), false, "Quick start not seen");
  assert.equal(bugButtonVisible({ ...base, quickStartGate: true }), false, "behind the Quick start gate");
  assert.equal(bugButtonVisible({ ...base, bugReports: false }), false, "a switch is off");
});

test("a bug is a response trigger, never an offer trigger", () => {
  assert.deepEqual([...SURVEY_RESPONSE_TRIGGERS], [...SURVEY_TRIGGERS, "bug"]);
  assert.equal((SURVEY_TRIGGERS as readonly string[]).includes("bug"), false);
  assert.equal(parseStoredOffer({ surveyVersion: 1, trigger: "bug", feature: null, rotating: "rotating.look" }), null);
});

test("the picker: InnoBox in general, then Bug while bug reports are on, then the catalog", () => {
  const withBug = surveyPickerOptions(true);
  assert.deepEqual(withBug.slice(0, 2), [
    { value: "", label: "InnoBox in general" },
    { value: BUG_PICKER_VALUE, label: "Bug" },
  ]);
  assert.deepEqual(
    withBug.slice(2).map((o) => o.value),
    SURVEY_FEATURES.map((f) => f.key),
  );
  assert.equal(withBug[2]!.label, "Submitting a challenge");
  const without = surveyPickerOptions(false);
  assert.equal(without.some((o) => o.value === BUG_PICKER_VALUE), false);
  assert.equal(without.length, withBug.length - 1);
});

test("validateBugReport: a trimmed, non-empty description of at most 2000 characters", () => {
  const ok = validateBugReport({ description: "  It broke.  ", pagePath: "/challenges/12", fromOffer: false });
  assert.deepEqual(ok, { ok: true, value: { description: "It broke.", pagePath: "/challenges/12", fromOffer: false } });
  for (const bad of [{}, { description: "" }, { description: "   \n " }, { description: 42 }, { description: "x".repeat(SURVEY_FREE_TEXT_MAX + 1) }]) {
    assert.equal(validateBugReport(bad).ok, false, JSON.stringify(bad).slice(0, 40));
  }
  assert.equal(validateBugReport({ description: "x".repeat(SURVEY_FREE_TEXT_MAX) }).ok, true);
  assert.equal(validateBugReport({ description: "x", fromOffer: "yes" }).ok, false);
  for (const bad of [null, [], "text"]) assert.equal(validateBugReport(bad).ok, false);
});

test("validateBugReport: fromOffer defaults to false; an invalid path is kept as null, not refused", () => {
  const r = validateBugReport({ description: "x", pagePath: "https://evil.example/" });
  assert.deepEqual(r, { ok: true, value: { description: "x", pagePath: null, fromOffer: false } });
  const o = validateBugReport({ description: "x", pagePath: null, fromOffer: true });
  assert.deepEqual(o, { ok: true, value: { description: "x", pagePath: null, fromOffer: true } });
});

test("sanitizeBugPagePath: the path only — query and fragment stripped", () => {
  assert.equal(sanitizeBugPagePath("/search?q=salary+review"), "/search");
  assert.equal(sanitizeBugPagePath("/challenges/7#comment-3"), "/challenges/7");
  assert.equal(sanitizeBugPagePath("/challenges?status=new#top"), "/challenges");
  assert.equal(sanitizeBugPagePath("/"), "/");
});

test("sanitizeBugPagePath: rejects API routes, a non-/ start, control characters and over-long paths", () => {
  assert.equal(sanitizeBugPagePath("/api/me"), null);
  assert.equal(sanitizeBugPagePath("/api/"), null);
  assert.equal(sanitizeBugPagePath("/apiary"), "/apiary", "only the /api/ prefix is refused");
  assert.equal(sanitizeBugPagePath("challenges/1"), null);
  assert.equal(sanitizeBugPagePath("https://example.com/x"), null);
  assert.equal(sanitizeBugPagePath(""), null);
  assert.equal(sanitizeBugPagePath("?q=x"), null);
  assert.equal(sanitizeBugPagePath("/a\nb"), null);
  assert.equal(sanitizeBugPagePath("/profile‮/x"), null, "a bidi override could disguise the path");
  assert.equal(sanitizeBugPagePath("/a⁦b"), null);
  assert.equal(sanitizeBugPagePath(null), null);
  assert.equal(sanitizeBugPagePath(12), null);
  const max = "/" + "a".repeat(BUG_PAGE_PATH_MAX - 1);
  assert.equal(sanitizeBugPagePath(max), max);
  assert.equal(sanitizeBugPagePath(max + "a"), null);
  assert.equal(sanitizeBugPagePath(max + "?long=" + "q".repeat(600)), max, "the cap applies after the query is cut");
});

test("bug-button click, case 1: no offer — an offer-less card, the others startable or on cooldown", () => {
  assert.deepEqual(bugClickDecision({ openOffer: null, card: null, selfNextAt: null, now: NOW }), {
    kind: "offerless",
    closeRandom: false,
    others: { state: "startable" },
  });
  const nextAt = new Date(NOW.getTime() + 3 * 86_400_000);
  assert.deepEqual(bugClickDecision({ openOffer: null, card: null, selfNextAt: nextAt, now: NOW }), {
    kind: "offerless",
    closeRandom: false,
    others: { state: "cooldown", nextAt },
  });
  // A cooldown read earlier that has ended since (a long-open tab) counts as over.
  const past = new Date(NOW.getTime() - 60_000);
  assert.deepEqual(bugClickDecision({ openOffer: null, card: null, selfNextAt: past, now: NOW }), {
    kind: "offerless",
    closeRandom: false,
    others: { state: "startable" },
  });
});

test("bug-button click, case 2: a self offer — reopen it with Bug, or switch an open card", () => {
  assert.deepEqual(bugClickDecision({ openOffer: "self", card: null, selfNextAt: null, now: NOW }), { kind: "reopen" });
  assert.deepEqual(bugClickDecision({ openOffer: "self", card: { holdsOffer: true }, selfNextAt: null, now: NOW }), { kind: "switch" });
});

test("bug-button click, case 3: a random offer — close its open card first, the others disabled", () => {
  for (const trigger of ["feature", "visit"] as const) {
    assert.deepEqual(bugClickDecision({ openOffer: trigger, card: { holdsOffer: true }, selfNextAt: null, now: NOW }), {
      kind: "offerless",
      closeRandom: true,
      others: { state: "random" },
    });
    assert.deepEqual(bugClickDecision({ openOffer: trigger, card: null, selfNextAt: null, now: NOW }), {
      kind: "offerless",
      closeRandom: false,
      others: { state: "random" },
    });
  }
});

test("bug-button click, case 4: an offer-less bug card already open — just focus it", () => {
  for (const openOffer of [null, "feature", "self"] as const) {
    assert.deepEqual(bugClickDecision({ openOffer, card: { holdsOffer: false }, selfNextAt: null, now: NOW }), { kind: "focus" });
  }
});

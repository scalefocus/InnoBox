// What's new — the update notice's rules and the changelog's integrity (INNOBOX_SPEC.md §13.9).
//
// The notice and the page both lean on properties of CHANGELOG — newest first, strict versions,
// the head equal to APP_VERSION — so the integrity half fails the build the moment an entry
// breaks one of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_VERSION } from "@innobox/shared/version";
import { CHANGELOG } from "../app/whats-new/changelog";
import {
  NOTICE_EXCERPT_MAX,
  SINCE_ALL,
  compareVersions,
  entriesPast,
  isCalendarDate,
  isVersion,
  missedEntries,
  noticeExcerpt,
  noticeLinkLabel,
  parseVersion,
  resolvePageBoundary,
  sinceForLink,
  stampAdvances,
  validStampVersion,
  whatsNewAction,
  type ReleaseEntry,
} from "./whats-new";

// ── Versions ────────────────────────────────────────────────────────────────────────────────

test("parseVersion accepts strict x.y.z only", () => {
  assert.deepEqual(parseVersion("0.51.6"), [0, 51, 6]);
  assert.deepEqual(parseVersion("10.0.0"), [10, 0, 0]);
  for (const bad of ["", "1.2", "1.2.3.4", "v1.2.3", "1.2.3-rc.1", "01.2.3", "1.02.3", " 1.2.3", "1.2.x", null, 123, undefined]) {
    assert.equal(parseVersion(bad), null, `${String(bad)} must be rejected`);
  }
});

test("compareVersions orders numerically, not lexically", () => {
  assert.ok(compareVersions("0.9.0", "0.10.0") < 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  assert.equal(compareVersions("0.51.6", "0.51.6"), 0);
  assert.ok(compareVersions("0.51.5", "0.51.6") < 0);
});

test("isCalendarDate rejects impossible dates", () => {
  assert.equal(isCalendarDate("2026-10-12"), true);
  assert.equal(isCalendarDate("2024-02-29"), true);
  assert.equal(isCalendarDate("2026-02-29"), false);
  assert.equal(isCalendarDate("2026-13-01"), false);
  assert.equal(isCalendarDate("2026-1-01"), false);
  assert.equal(isCalendarDate(null), false);
});

// ── The trigger rule ────────────────────────────────────────────────────────────────────────

test("trigger: a never-stamped (null) marker shows", () => {
  assert.equal(whatsNewAction(null, "1.2.3", true), "show");
});

test("trigger: every release size shows — patch, minor and major alike", () => {
  assert.equal(whatsNewAction("1.2.2", "1.2.3", true), "show", "patch");
  assert.equal(whatsNewAction("1.1.9", "1.2.0", true), "show", "minor");
  assert.equal(whatsNewAction("0.99.0", "1.0.0", true), "show", "major");
  assert.equal(whatsNewAction("0.40.0", "1.2.3", true), "show", "several skipped");
});

test("trigger: an acknowledged release shows nothing", () => {
  assert.equal(whatsNewAction("1.2.3", "1.2.3", true), "none");
});

test("trigger: a rollback or a stale cached bundle shows nothing", () => {
  assert.equal(whatsNewAction("1.3.0", "1.2.3", true), "none");
});

test("trigger: an invalid stored marker counts as never stamped; an invalid bundle version never shows", () => {
  assert.equal(whatsNewAction("garbage", "1.2.3", true), "show");
  assert.equal(whatsNewAction(null, "1.2", true), "none");
  assert.equal(whatsNewAction("1.0.0", "dev", true), "none");
});

test("trigger: nothing while Quick start has not been seen", () => {
  assert.equal(whatsNewAction(null, "1.2.3", false), "none");
  assert.equal(whatsNewAction("1.0.0", "1.2.3", false), "none");
});

// ── Missed entries, excerpt, link ───────────────────────────────────────────────────────────

const LOG: ReleaseEntry[] = [
  { version: "1.4.0", date: "2026-10-12" },
  { version: "1.3.1", date: "2026-10-10" },
  { version: "1.3.0", date: "2026-10-08" },
  { version: "1.2.0", date: "2026-10-01" },
  { version: "1.1.0", date: "2026-09-20" },
];
const versions = (entries: readonly ReleaseEntry[]) => entries.map((e) => e.version);

test("missed: a valid marker selects every newer entry, newest first", () => {
  assert.deepEqual(versions(missedEntries(LOG, { seen: "1.2.0", sinceDate: null, current: "1.4.0" })), ["1.4.0", "1.3.1", "1.3.0"]);
  // The marker wins over a rollout date that might still be present.
  assert.deepEqual(versions(missedEntries(LOG, { seen: "1.3.1", sinceDate: "2026-09-01", current: "1.4.0" })), ["1.4.0"]);
});

test("missed: a null marker uses the rollout date, on or after it", () => {
  assert.deepEqual(versions(missedEntries(LOG, { seen: null, sinceDate: "2026-10-08", current: "1.4.0" })), ["1.4.0", "1.3.1", "1.3.0"]);
  assert.deepEqual(versions(missedEntries(LOG, { seen: "nope", sinceDate: "2026-10-09", current: "1.4.0" })), ["1.4.0", "1.3.1"]);
});

test("missed: neither marker nor date — the current entry alone", () => {
  assert.deepEqual(versions(missedEntries(LOG, { seen: null, sinceDate: null, current: "1.4.0" })), ["1.4.0"]);
  // A rollout date past every entry also falls back, so a due notice is never empty.
  assert.deepEqual(versions(missedEntries(LOG, { seen: null, sinceDate: "2026-10-20", current: "1.4.0" })), ["1.4.0"]);
});

test("excerpt: capped at three entries; the link counts all of them", () => {
  const missed = missedEntries(LOG, { seen: "1.1.0", sinceDate: null, current: "1.4.0" });
  assert.equal(missed.length, 4);
  assert.equal(NOTICE_EXCERPT_MAX, 3);
  assert.deepEqual(versions(noticeExcerpt(missed)), ["1.4.0", "1.3.1", "1.3.0"]);
  assert.equal(noticeLinkLabel(missed, "1.4.0"), "See what's new since your last visit (4)");
});

test("link label: the plain form when only the current entry was missed", () => {
  assert.equal(noticeLinkLabel([LOG[0]!], "1.4.0"), "See what's new");
  assert.equal(noticeLinkLabel([LOG[1]!], "1.4.0"), "See what's new since your last visit (1)");
});

test("link since: the newest entry that was not missed, or 0.0.0 when all were", () => {
  assert.equal(sinceForLink(LOG, missedEntries(LOG, { seen: "1.2.0", sinceDate: null, current: "1.4.0" })), "1.2.0");
  assert.equal(sinceForLink(LOG, [LOG[0]!]), "1.3.1");
  assert.equal(sinceForLink(LOG, LOG), SINCE_ALL);
  // The page, given that since, highlights exactly what the notice counted.
  const missed = missedEntries(LOG, { seen: null, sinceDate: "2026-10-09", current: "1.4.0" });
  assert.deepEqual(versions(entriesPast(LOG, { kind: "version", version: sinceForLink(LOG, missed) })), versions(missed));
  assert.deepEqual(versions(entriesPast(LOG, { kind: "version", version: SINCE_ALL })), versions(LOG));
});

// ── The page's boundary ─────────────────────────────────────────────────────────────────────

test("page boundary: a valid ?since= wins", () => {
  assert.deepEqual(resolvePageBoundary({ since: "1.2.0", markerBeforeStamp: "1.3.0", sinceDate: "2026-01-01" }), {
    kind: "version",
    version: "1.2.0",
  });
  assert.deepEqual(resolvePageBoundary({ since: "0.0.0", markerBeforeStamp: null, sinceDate: null }), { kind: "version", version: "0.0.0" });
});

test("page boundary: an invalid ?since= falls through to the pre-stamp marker", () => {
  assert.deepEqual(resolvePageBoundary({ since: "latest", markerBeforeStamp: "1.3.0", sinceDate: "2026-01-01" }), {
    kind: "version",
    version: "1.3.0",
  });
});

test("page boundary: a null marker falls back to the rollout date, then to nothing", () => {
  assert.deepEqual(resolvePageBoundary({ since: null, markerBeforeStamp: null, sinceDate: "2026-10-09" }), {
    kind: "date",
    date: "2026-10-09",
  });
  assert.equal(resolvePageBoundary({ since: null, markerBeforeStamp: null, sinceDate: null }), null);
  assert.equal(resolvePageBoundary({ since: "", markerBeforeStamp: "x", sinceDate: "2026-02-30" }), null);
});

// ── The stamp's guards ──────────────────────────────────────────────────────────────────────

test("stamp: a version must be strict and not newer than the server's", () => {
  assert.equal(validStampVersion("1.2.3", "1.2.3"), "1.2.3");
  assert.equal(validStampVersion("1.2.2", "1.2.3"), "1.2.2");
  assert.equal(validStampVersion("1.2.4", "1.2.3"), null, "the future");
  assert.equal(validStampVersion("1.2", "1.2.3"), null);
  assert.equal(validStampVersion(123, "1.2.3"), null);
});

test("stamp: only advances a null, invalid or strictly lower marker", () => {
  assert.equal(stampAdvances(null, "1.2.3"), true);
  assert.equal(stampAdvances("junk", "1.2.3"), true);
  assert.equal(stampAdvances("1.2.2", "1.2.3"), true);
  assert.equal(stampAdvances("1.2.3", "1.2.3"), false);
  assert.equal(stampAdvances("1.3.0", "1.2.3"), false);
});

// ── Changelog integrity ─────────────────────────────────────────────────────────────────────

test("changelog: the newest entry is the running APP_VERSION", () => {
  assert.equal(CHANGELOG[0]?.version, APP_VERSION);
});

test("changelog: every version is strict x.y.z and unique", () => {
  const bad = CHANGELOG.filter((e) => !isVersion(e.version)).map((e) => e.version);
  assert.deepEqual(bad, [], `not strict x.y.z: ${bad.join(", ")}`);
  const seen = new Set<string>();
  const dupes = CHANGELOG.filter((e) => (seen.has(e.version) ? true : (seen.add(e.version), false))).map((e) => e.version);
  assert.deepEqual(dupes, [], `duplicate versions: ${dupes.join(", ")}`);
});

test("changelog: versions are strictly descending", () => {
  for (let i = 1; i < CHANGELOG.length; i++) {
    const newer = CHANGELOG[i - 1]!.version;
    const older = CHANGELOG[i]!.version;
    assert.ok(compareVersions(newer, older) > 0, `${newer} must come before ${older} and be greater`);
  }
});

test("changelog: every date is a valid YYYY-MM-DD", () => {
  const bad = CHANGELOG.filter((e) => !isCalendarDate(e.date)).map((e) => `${e.version} (${e.date})`);
  assert.deepEqual(bad, [], `invalid dates: ${bad.join(", ")}`);
});

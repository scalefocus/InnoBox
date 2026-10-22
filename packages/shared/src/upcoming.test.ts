// The What's new "Coming soon" list (INNOBOX_SPEC.md §13.9).
//
// The spec-sync half ties UPCOMING to the open "⚠ GAP-nn · new feature" markers in
// INNOBOX_SPEC.md and ENTRA_AUTH_SPEC.md, in both directions: every teased id must still be an
// open new-feature marker, and every open new-feature marker must be teased by exactly one entry.
// Specifying a feature therefore forces a teaser in; shipping it (which deletes its markers)
// forces the teaser out. Code-fix markers are never teased. The key half keeps every teaser's
// permanent `key` (§38.2) well formed and unique, and off the dropped list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DROPPED_UPCOMING_KEYS, UPCOMING, UPCOMING_KEY_PATTERN, appliesTo, upcomingByKey, upcomingFor, type UpcomingEntry } from "./upcoming.js";

// packages/shared/src (or dist, where the compiled test runs) → repo root.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SPECS = ["INNOBOX_SPEC.md", "ENTRA_AUTH_SPEC.md"];

function openMarkers(kind: "new feature" | "code fix"): Set<string> {
  const pattern = new RegExp(`⚠ (GAP-\\d+) · ${kind}`, "g");
  const ids = new Set<string>();
  for (const file of SPECS) {
    const text = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const match of text.matchAll(pattern)) ids.add(match[1]!);
  }
  return ids;
}

test("every teased id is an open new-feature marker in the spec", () => {
  const open = openMarkers("new feature");
  const stale = UPCOMING.flatMap((entry) => entry.ids).filter((id) => !open.has(id));
  assert.deepEqual(stale, [], `teased but no longer an open new-feature marker: ${stale.join(", ")}`);
});

test("every open new-feature marker is teased by exactly one entry", () => {
  const counts = new Map<string, number>();
  for (const id of UPCOMING.flatMap((entry) => entry.ids)) counts.set(id, (counts.get(id) ?? 0) + 1);
  const missing = [...openMarkers("new feature")].filter((id) => !counts.has(id));
  const duplicated = [...counts].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepEqual(missing, [], `open new-feature markers with no teaser: ${missing.join(", ")}`);
  assert.deepEqual(duplicated, [], `markers teased more than once: ${duplicated.join(", ")}`);
});

test("code-fix markers are never teased", () => {
  const fixes = openMarkers("code fix");
  const teased = UPCOMING.flatMap((entry) => entry.ids).filter((id) => fixes.has(id));
  assert.deepEqual(teased, []);
});

test("every entry has ids, a title and a teaser, and its copy leaks no internal reference", () => {
  for (const entry of UPCOMING) {
    assert.ok(entry.ids.length > 0, `${entry.title}: no ids`);
    assert.ok(entry.title.trim().length > 0 && entry.teaser.trim().length > 0, `${entry.ids}: empty copy`);
    for (const copy of [entry.title, entry.teaser]) {
      assert.doesNotMatch(copy, /GAP-\d+/, `${entry.ids}: marker id in user-facing copy`);
      assert.ok(!copy.includes(String.fromCharCode(0xa7)), `${entry.ids}: spec section mark in copy`);
    }
  }
});

const everyone: UpcomingEntry = { key: "entry-a", ids: ["GAP-1"], title: "A", teaser: "a", audience: "everyone" };
const admins: UpcomingEntry = { key: "entry-b", ids: ["GAP-2"], title: "B", teaser: "b", audience: "admins" };
const platform: UpcomingEntry = { key: "entry-c", ids: ["GAP-3"], title: "C", teaser: "c", audience: "platform_admin" };
const all = [everyone, admins, platform];

test("a member sees only everyone-entries", () => {
  assert.deepEqual(upcomingFor({ platformAdmin: false, namespaceAdmin: [] }, all), [everyone]);
});

test("a namespace admin also sees admin entries, but not platform-admin ones", () => {
  assert.deepEqual(upcomingFor({ platformAdmin: false, namespaceAdmin: ["ns-1"] }, all), [everyone, admins]);
});

test("a platform admin sees every entry, in list order", () => {
  assert.deepEqual(upcomingFor({ platformAdmin: true, namespaceAdmin: [] }, all), all);
  assert.equal(appliesTo("admins", { platformAdmin: true, namespaceAdmin: [] }), true);
});

test("every teaser key is a unique kebab-case slug, and no live key is on the dropped list", () => {
  const keys = UPCOMING.map((entry) => entry.key);
  for (const key of keys) assert.match(key, UPCOMING_KEY_PATTERN, `malformed teaser key: ${key}`);
  assert.equal(new Set(keys).size, keys.length, "duplicate teaser keys");
  const revived = keys.filter((key) => DROPPED_UPCOMING_KEYS.includes(key));
  assert.deepEqual(revived, [], `a live teaser reuses a dropped key: ${revived.join(", ")}`);
  for (const key of DROPPED_UPCOMING_KEYS) assert.match(key, UPCOMING_KEY_PATTERN, `malformed dropped key: ${key}`);
});

test("the key pattern accepts slugs and refuses anything else", () => {
  for (const ok of ["feedback-survey", "a", "ai-2", "x-y-z"]) assert.match(ok, UPCOMING_KEY_PATTERN);
  for (const bad of ["", "Feedback", "a--b", "-a", "a-", "a b", "spec:a", "a_b"]) assert.doesNotMatch(bad, UPCOMING_KEY_PATTERN);
});

test("upcomingByKey finds a live teaser and nothing else", () => {
  assert.equal(upcomingByKey("entry-b", all), admins);
  assert.equal(upcomingByKey("entry-z", all), undefined);
});

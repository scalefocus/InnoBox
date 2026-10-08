// Unit tests for the shared breadcrumb's crumb contract (INNOBOX_SPEC.md §14). The two
// invariants most worth guarding: the trail always leads back to the Administration
// console, and the trailing current-page crumb is NEVER a link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { adminCrumbs } from "./breadcrumb-crumbs";

test("adminCrumbs: leads with a link back to the Administration console", () => {
  const [first] = adminCrumbs("Triage queue");
  assert.ok(first);
  assert.equal(first.label, "Administration");
  assert.equal(first.href, "/admin");
});

test("adminCrumbs: the current page is the trailing crumb and is not a link", () => {
  const crumbs = adminCrumbs("Audit log");
  assert.equal(crumbs.length, 2);
  const last = crumbs.at(-1);
  assert.ok(last);
  assert.equal(last.label, "Audit log");
  assert.equal(last.href, undefined); // plain text — must never link to the current page
});

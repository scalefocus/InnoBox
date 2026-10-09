// Unit tests for the §15 audit-browser vocabulary: the category parser and the prefix table.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY_LABEL,
  AUDIT_CATEGORY_PATTERNS,
  AUDIT_EXPORT_CAP,
  AUDIT_PAGE_SIZE,
  LEGACY_TRIAGE_EXPORT_ACTION,
  parseAuditCategory,
} from "./audit-browser.js";

test("parseAuditCategory accepts the chips and falls back to All", () => {
  for (const c of AUDIT_CATEGORIES) assert.equal(parseAuditCategory(c), c);
  assert.equal(parseAuditCategory("nonsense"), "all");
  assert.equal(parseAuditCategory(null), "all");
});

test("every non-All category has a label and at least one LIKE pattern", () => {
  for (const c of AUDIT_CATEGORIES) {
    assert.ok(AUDIT_CATEGORY_LABEL[c]);
    if (c !== "all") assert.ok(AUDIT_CATEGORY_PATTERNS[c].length > 0, c);
  }
});

test("the spec's prefixes are covered", () => {
  assert.deepEqual(AUDIT_CATEGORY_PATTERNS.challenges, ["challenge.%"]);
  assert.ok(AUDIT_CATEGORY_PATTERNS.identity.includes("scim.%"));
  assert.ok(AUDIT_CATEGORY_PATTERNS.identity.includes("role_mapping.%"));
  assert.ok(AUDIT_CATEGORY_PATTERNS.admin.includes("%.exported"), "every export lands under Admin");
  assert.ok(AUDIT_CATEGORY_PATTERNS.admin.includes("system_banner.%"));
  assert.ok(AUDIT_CATEGORY_PATTERNS.admin.includes("audit.%"), "audit.chain_started / audit.verified land under Admin");
  assert.ok(AUDIT_CATEGORY_PATTERNS.admin.includes("webhook.%"), "channel-webhook changes land under Admin");
  assert.equal(AUDIT_PAGE_SIZE, 100);
  assert.equal(AUDIT_EXPORT_CAP, 50_000);
});

/** SQL LIKE semantics for the patterns above (`%` = any run, `_` = any one char). */
function likeMatches(pattern: string, value: string): boolean {
  const re = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${re}$`).test(value);
}
const inCategory = (category: keyof typeof AUDIT_CATEGORY_PATTERNS, action: string) =>
  AUDIT_CATEGORY_PATTERNS[category].some((p) => likeMatches(p, action));

test("every export lands under Admin — the triage export under its current and its legacy name", () => {
  for (const action of ["audit.exported", "triage.exported", LEGACY_TRIAGE_EXPORT_ACTION]) {
    assert.ok(inCategory("admin", action), action);
  }
  assert.equal(LEGACY_TRIAGE_EXPORT_ACTION, "admin.triage_exported", "historical rows carry exactly this name");
  assert.ok(!inCategory("admin", "challenge.status_changed"), "the Admin chip does not swallow domain events");
});

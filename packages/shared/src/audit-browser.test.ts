// Unit tests for the §15 audit-browser vocabulary: the category parser and the prefix table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AUDIT_CATEGORIES, AUDIT_CATEGORY_LABEL, AUDIT_CATEGORY_PATTERNS, AUDIT_EXPORT_CAP, AUDIT_PAGE_SIZE, parseAuditCategory } from "./audit-browser.js";

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

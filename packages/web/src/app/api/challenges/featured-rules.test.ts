// Unit tests for the pure §13.2 *Featured challenges* / §14.3 rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEATURED_LIMIT_DEFAULT,
  FEATURED_LIMIT_MAX,
  FEATURED_LIMIT_MIN,
  featuredCapMessage,
  featuredDetailFields,
  isAtFeaturedCap,
  isFeaturableStatus,
  normalizeStoredFeaturedLimit,
  parseFeaturedLimit,
  transitionClearsPin,
} from "./featured-rules.js";

test("§14.3: the featured limit defaults to 3 within 1–6", () => {
  assert.equal(FEATURED_LIMIT_DEFAULT, 3);
  assert.equal(FEATURED_LIMIT_MIN, 1);
  assert.equal(FEATURED_LIMIT_MAX, 6);
});

test("§13.2: only valid and solved are featurable", () => {
  for (const s of ["valid", "solved"]) assert.equal(isFeaturableStatus(s), true, s);
  for (const s of ["awaiting_triage", "in_review", "needs_improvement", "meeting_scheduled", "rejected", "withdrawn", "bogus"]) {
    assert.equal(isFeaturableStatus(s), false, s);
  }
});

test("§13.2: valid ↔ solved keeps the pin; every other target clears it", () => {
  assert.equal(transitionClearsPin("valid"), false);
  assert.equal(transitionClearsPin("solved"), false);
  for (const s of ["rejected", "withdrawn", "in_review", "needs_improvement", "meeting_scheduled", "awaiting_triage"]) {
    assert.equal(transitionClearsPin(s), true, s);
  }
});

test("parseFeaturedLimit: integers 1–6 only", () => {
  for (const n of [1, 3, 6]) assert.deepEqual(parseFeaturedLimit(n), { ok: true, value: n });
  for (const bad of [0, 7, -1, 2.5, "3", null, undefined, Number.NaN]) {
    const parsed = parseFeaturedLimit(bad);
    assert.equal(parsed.ok, false, String(bad));
    if (!parsed.ok) assert.ok(!parsed.error.includes("§"), "no spec reference in a user-facing error");
  }
});

test("normalizeStoredFeaturedLimit: missing or corrupt stored values fall back to the default", () => {
  assert.equal(normalizeStoredFeaturedLimit(undefined), 3);
  assert.equal(normalizeStoredFeaturedLimit(null), 3);
  assert.equal(normalizeStoredFeaturedLimit(42), 3);
  assert.equal(normalizeStoredFeaturedLimit("5"), 3);
  assert.equal(normalizeStoredFeaturedLimit(5), 5);
});

test("isAtFeaturedCap: refuses at and above the limit (a lowered limit unpins nothing)", () => {
  assert.equal(isAtFeaturedCap(2, 3), false);
  assert.equal(isAtFeaturedCap(3, 3), true);
  // The limit was lowered from 5 to 2 with 4 pins standing: still refused, nothing evicted.
  assert.equal(isAtFeaturedCap(4, 2), true);
  assert.equal(isAtFeaturedCap(1, 2), false);
});

test("featuredCapMessage names the configured limit", () => {
  assert.equal(featuredCapMessage(3), "3 challenges are already featured. Unfeature one first.");
  assert.equal(featuredCapMessage(1), "1 challenge is already featured. Unfeature one first.");
});

test("featuredDetailFields: provenance only for a platform admin on an eligible status", () => {
  const at = new Date("2026-10-01T10:00:00Z");
  assert.deepEqual(featuredDetailFields({ isPlatformAdmin: true, status: "valid", featuredAt: at, featuredByName: "Ada" }), {
    featured: true,
    canFeature: true,
    featuredAt: at.toISOString(),
    featuredBy: "Ada",
  });
  // A non-admin learns only the boolean — no who/when.
  assert.deepEqual(featuredDetailFields({ isPlatformAdmin: false, status: "valid", featuredAt: at, featuredByName: "Ada" }), {
    featured: true,
    canFeature: false,
  });
  // Ineligible status: no control for anyone.
  assert.deepEqual(featuredDetailFields({ isPlatformAdmin: true, status: "in_review", featuredAt: null, featuredByName: null }), {
    featured: false,
    canFeature: false,
  });
  // Unpinned, eligible, admin: the control without provenance.
  assert.deepEqual(featuredDetailFields({ isPlatformAdmin: true, status: "solved", featuredAt: null, featuredByName: null }), {
    featured: false,
    canFeature: true,
  });
});

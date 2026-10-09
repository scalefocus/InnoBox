import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isEntityNumber,
  isUuid,
  parseChallengeCreateIds,
  parseChallengeListFilters,
  parseGalleryFilters,
  parseLikeToggle,
  parseStatusOverride,
} from "./validation.js";

const AREA_ID = "11111111-1111-1111-1111-111111111111";
const NS_ID = "22222222-2222-2222-2222-222222222222";

test("isUuid accepts well-formed uuids and rejects everything else", () => {
  assert.equal(isUuid(AREA_ID), true);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid(""), false);
});

test("parseChallengeListFilters: defaults to tab=open, sort=newest with no params", () => {
  const result = parseChallengeListFilters(new URLSearchParams());
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { tab: "open", sort: "newest" });
});

test("parseChallengeListFilters: accepts all documented tab/sort/status values", () => {
  const result = parseChallengeListFilters(
    new URLSearchParams({ tab: "mine", sort: "most_liked", status: "valid" }),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.tab, "mine");
    assert.equal(result.value.sort, "most_liked");
    assert.equal(result.value.status, "valid");
  }
});

test("parseGalleryFilters: parses the four §13.1 filters and nothing else (search reuses it)", () => {
  const result = parseGalleryFilters(
    new URLSearchParams({ status: "valid", impactAreaId: AREA_ID, namespaceId: NS_ID, authorName: " Jane ", tab: "mine", q: "x" }),
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { status: "valid", impactAreaId: AREA_ID, namespaceId: NS_ID, authorName: "Jane" });
  assert.deepEqual(parseGalleryFilters(new URLSearchParams()), { ok: true, value: {} });
});

test("parseGalleryFilters: fails closed on a malformed filter", () => {
  assert.equal(parseGalleryFilters(new URLSearchParams({ status: "bogus" })).ok, false);
  assert.equal(parseGalleryFilters(new URLSearchParams({ impactAreaId: "nope" })).ok, false);
  assert.equal(parseGalleryFilters(new URLSearchParams({ namespaceId: "nope" })).ok, false);
});

test("parseChallengeListFilters: rejects an unknown tab rather than silently defaulting", () => {
  const result = parseChallengeListFilters(new URLSearchParams({ tab: "bogus" }));
  assert.equal(result.ok, false);
});

test("parseChallengeListFilters: rejects an unknown status value", () => {
  const result = parseChallengeListFilters(new URLSearchParams({ status: "bogus" }));
  assert.equal(result.ok, false);
});

test("parseChallengeListFilters: rejects malformed impactAreaId/namespaceId", () => {
  assert.equal(parseChallengeListFilters(new URLSearchParams({ impactAreaId: "nope" })).ok, false);
  assert.equal(parseChallengeListFilters(new URLSearchParams({ namespaceId: "nope" })).ok, false);
});

test("parseChallengeListFilters: trims authorName, omits when blank", () => {
  const withName = parseChallengeListFilters(new URLSearchParams({ authorName: "  Jane  " }));
  assert.equal(withName.ok, true);
  if (withName.ok) assert.equal(withName.value.authorName, "Jane");

  const blank = parseChallengeListFilters(new URLSearchParams({ authorName: "   " }));
  assert.equal(blank.ok, true);
  if (blank.ok) assert.equal(blank.value.authorName, undefined);
});

test("parseChallengeCreateIds: accepts well-formed uuids for both ids", () => {
  const result = parseChallengeCreateIds({ impactAreaId: AREA_ID, namespaceId: NS_ID });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { impactAreaId: AREA_ID, namespaceId: NS_ID });
});

test("parseChallengeCreateIds: rejects a non-object body", () => {
  assert.equal(parseChallengeCreateIds(null).ok, false);
  assert.equal(parseChallengeCreateIds("string").ok, false);
  assert.equal(parseChallengeCreateIds([]).ok, false);
});

test("parseChallengeCreateIds: rejects missing or malformed ids", () => {
  assert.equal(parseChallengeCreateIds({ impactAreaId: AREA_ID }).ok, false);
  assert.equal(parseChallengeCreateIds({ impactAreaId: "x", namespaceId: NS_ID }).ok, false);
});

test("parseStatusOverride: accepts a value the predicate approves", () => {
  const result = parseStatusOverride({ status: "valid" }, (s) => s === "valid");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value, "valid");
});

test("parseStatusOverride: rejects a value the predicate refuses", () => {
  const result = parseStatusOverride({ status: "bogus" }, (s) => s === "valid");
  assert.equal(result.ok, false);
});

test("parseLikeToggle: accepts a well-formed challenge/solution toggle", () => {
  const result = parseLikeToggle({ parentType: "challenge", parentId: AREA_ID });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { parentType: "challenge", parentId: AREA_ID });
});

test("parseLikeToggle: rejects an unknown parentType", () => {
  const result = parseLikeToggle({ parentType: "comment", parentId: AREA_ID });
  assert.equal(result.ok, false);
});

test("parseLikeToggle: rejects a malformed parentId", () => {
  const result = parseLikeToggle({ parentType: "challenge", parentId: "nope" });
  assert.equal(result.ok, false);
});

test("isEntityNumber: canonical positive integers only (a malformed path number is a 404, never a DB cast error)", () => {
  for (const ok of ["1", "42", "999999999999999999"]) assert.equal(isEntityNumber(ok), true, ok);
  for (const bad of ["", "0", "-1", "01", "1.5", "1e3", "abc", "CH-1", " 1", "1 ", "9999999999999999999", "١"]) {
    assert.equal(isEntityNumber(bad), false, JSON.stringify(bad));
  }
});

// ── §6.1 duplicate warning ───────────────────────────────────────────────────────────────

test("parseSimilarRequest trims, caps, and needs at least one of title/description", async () => {
  const { parseSimilarRequest } = await import("./validation.js");
  const ok = parseSimilarRequest({ title: "  Slow builds  ", description: "x".repeat(5_000) });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.value.title, "Slow builds");
    assert.equal(ok.value.description.length, 2_000, "the description is ranked on its first 2 000 characters");
  }
  assert.equal(parseSimilarRequest({ title: "", description: "  " }).ok, false);
  assert.equal(parseSimilarRequest(null).ok, false);
  assert.equal(parseSimilarRequest({ title: 42, description: "only this" }).ok, true, "a wrong-typed field is just empty");
});

test("parseSimilarAcknowledged keeps well-formed numbers only, deduped, at most five", async () => {
  const { parseSimilarAcknowledged } = await import("./validation.js");
  assert.deepEqual(parseSimilarAcknowledged(["CH-12", "ch-7", " CH-12 ", "SOL-3", 5, "CH-x", "CH-0012"]), ["CH-12", "CH-7"]);
  assert.deepEqual(parseSimilarAcknowledged(["CH-1", "CH-2", "CH-3", "CH-4", "CH-5", "CH-6"]), ["CH-1", "CH-2", "CH-3", "CH-4", "CH-5"]);
  assert.deepEqual(parseSimilarAcknowledged("CH-1"), []);
  assert.deepEqual(parseSimilarAcknowledged(undefined), []);
});

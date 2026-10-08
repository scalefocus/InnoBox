import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isUuid,
  parseChallengeCreateIds,
  parseChallengeListFilters,
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

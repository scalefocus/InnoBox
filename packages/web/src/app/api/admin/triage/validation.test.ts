import { test } from "node:test";
import assert from "node:assert/strict";
import { isChallengeStatus } from "@innobox/shared";
import { parseBulkAssignBody, parseBulkStatusBody, parseBulkTopicBody, parseTriageFilters, parseTriagePagination } from "./validation.js";

test("parseTriageFilters: empty query yields no filters", () => {
  const parsed = parseTriageFilters(new URLSearchParams());
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value, {});
});

test("parseTriageFilters: accepts status/authorName/assigneeId=unassigned/number", () => {
  const parsed = parseTriageFilters(new URLSearchParams("status=valid&authorName=Jane&assigneeId=unassigned&number=CH-12"));
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.status, "valid");
    assert.equal(parsed.value.authorName, "Jane");
    assert.equal(parsed.value.assigneeId, "unassigned");
    assert.equal(parsed.value.number, "12");
  }
});

test("parseTriageFilters: rejects a malformed namespaceId or unknown status", () => {
  assert.equal(parseTriageFilters(new URLSearchParams("namespaceId=not-a-uuid")).ok, false);
  assert.equal(parseTriageFilters(new URLSearchParams("status=bogus")).ok, false);
});

test("parseTriageFilters: the §34.6 topic filter — a topic id or 'none'", () => {
  const id = "33333333-3333-3333-3333-333333333333";
  assert.deepEqual(parseTriageFilters(new URLSearchParams(`topic=${id}`)), { ok: true, value: { topicId: id } });
  assert.deepEqual(parseTriageFilters(new URLSearchParams("topic=none")), { ok: true, value: { topicId: "none" } });
  assert.equal(parseTriageFilters(new URLSearchParams("topic=ai")).ok, false);
});

test("parseBulkTopicBody: numbers, add or remove, and a topic id", () => {
  const id = "33333333-3333-3333-3333-333333333333";
  assert.deepEqual(parseBulkTopicBody({ numbers: ["CH-12", "13"], action: "add", topicId: id.toUpperCase() }), {
    ok: true,
    value: { numbers: ["12", "13"], action: "add", topicId: id },
  });
  assert.equal(parseBulkTopicBody({ numbers: [], action: "add", topicId: id }).ok, false);
  assert.equal(parseBulkTopicBody({ numbers: ["12"], action: "toggle", topicId: id }).ok, false);
  assert.equal(parseBulkTopicBody({ numbers: ["12"], action: "remove", topicId: "ai" }).ok, false);
});

test("parseTriageFilters: rejects a number that doesn't look like CH-123", () => {
  const parsed = parseTriageFilters(new URLSearchParams("number=abc"));
  assert.equal(parsed.ok, false);
});

test("parseTriagePagination: defaults to page 1, the default page size", () => {
  const parsed = parseTriagePagination(new URLSearchParams());
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value, { page: 1, pageSize: 50 });
});

test("parseTriagePagination: accepts explicit page/pageSize within bounds", () => {
  const parsed = parseTriagePagination(new URLSearchParams("page=3&pageSize=25"));
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value, { page: 3, pageSize: 25 });
});

test("parseTriagePagination: rejects non-positive page, non-integer, or pageSize over the cap", () => {
  assert.equal(parseTriagePagination(new URLSearchParams("page=0")).ok, false);
  assert.equal(parseTriagePagination(new URLSearchParams("page=1.5")).ok, false);
  assert.equal(parseTriagePagination(new URLSearchParams("pageSize=0")).ok, false);
  assert.equal(parseTriagePagination(new URLSearchParams("pageSize=101")).ok, false);
});

test("parseBulkStatusBody: accepts a non-empty numbers array + valid status", () => {
  const parsed = parseBulkStatusBody({ numbers: ["CH-1", "2"], status: "valid" }, isChallengeStatus);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value, { numbers: ["1", "2"], status: "valid" });
});

test("parseBulkStatusBody: rejects an empty array, non-string entries, or an invalid status", () => {
  assert.equal(parseBulkStatusBody({ numbers: [], status: "valid" }, isChallengeStatus).ok, false);
  assert.equal(parseBulkStatusBody({ numbers: [1], status: "valid" }, isChallengeStatus).ok, false);
  assert.equal(parseBulkStatusBody({ numbers: ["1"], status: "bogus" }, isChallengeStatus).ok, false);
});

test("parseBulkStatusBody: rejects an array over the 500-item cap (DoS guard)", () => {
  const numbers = Array.from({ length: 501 }, (_, i) => String(i));
  const parsed = parseBulkStatusBody({ numbers, status: "valid" }, isChallengeStatus);
  assert.equal(parsed.ok, false);
  const atCap = parseBulkStatusBody({ numbers: numbers.slice(0, 500), status: "valid" }, isChallengeStatus);
  assert.equal(atCap.ok, true);
});

test("parseBulkAssignBody: accepts a uuid assigneeUserId or null", () => {
  const uuid = "11111111-1111-1111-1111-111111111111";
  assert.equal(parseBulkAssignBody({ numbers: ["1"], assigneeUserId: uuid }).ok, true);
  assert.equal(parseBulkAssignBody({ numbers: ["1"], assigneeUserId: null }).ok, true);
});

test("parseBulkAssignBody: rejects a non-uuid assigneeUserId", () => {
  assert.equal(parseBulkAssignBody({ numbers: ["1"], assigneeUserId: "nope" }).ok, false);
});

test("parseBulkAssignBody: rejects an array over the 500-item cap (DoS guard)", () => {
  const numbers = Array.from({ length: 501 }, (_, i) => String(i));
  assert.equal(parseBulkAssignBody({ numbers, assigneeUserId: null }).ok, false);
});

// Unit tests for the §14.7 system-log rules: which statuses are recorded, message sanitizing,
// the status-chip parser, and the entity-in-path extraction behind anonymity masking.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SYSTEM_LOG_MESSAGE_MAX,
  entityInPath,
  errorCodeForStatus,
  parseSystemLogStatusFilter,
  pathWithoutQuery,
  sanitizeSystemMessage,
  shouldRecordSystemEvent,
} from "./system-log.js";

test("every 5xx is recorded; of 4xx only 403/409/413/422/429; never 401 or 404", () => {
  for (const s of [500, 502, 503, 599]) assert.equal(shouldRecordSystemEvent(s), true, String(s));
  for (const s of [403, 409, 413, 422, 429]) assert.equal(shouldRecordSystemEvent(s), true, String(s));
  for (const s of [200, 201, 204, 302, 400, 401, 404, 415]) assert.equal(shouldRecordSystemEvent(s), false, String(s));
});

test("sanitizeSystemMessage keeps one line, strips control characters, caps the length", () => {
  assert.equal(sanitizeSystemMessage("first line\nsecond line"), "first line");
  assert.equal(sanitizeSystemMessage("tab\there\u0007bell"), "tab here bell");
  assert.equal(sanitizeSystemMessage(new Error("boom\n    at stack")), "boom");
  assert.equal(sanitizeSystemMessage(null), "");
  assert.equal(sanitizeSystemMessage(42), "42");
  const long = sanitizeSystemMessage("x".repeat(SYSTEM_LOG_MESSAGE_MAX + 50));
  assert.equal(long.length, SYSTEM_LOG_MESSAGE_MAX);
  assert.ok(long.endsWith("…"));
});

test("the status-chip parser falls back to All", () => {
  assert.equal(parseSystemLogStatusFilter("5xx"), "5xx");
  assert.equal(parseSystemLogStatusFilter("429"), "429");
  assert.equal(parseSystemLogStatusFilter("409"), "all", "409 has no chip of its own");
  assert.equal(parseSystemLogStatusFilter(null), "all");
  assert.equal(parseSystemLogStatusFilter("nonsense"), "all");
});

test("errorCodeForStatus gives a short token per recorded status", () => {
  assert.equal(errorCodeForStatus(403), "forbidden");
  assert.equal(errorCodeForStatus(409), "conflict");
  assert.equal(errorCodeForStatus(413), "payload_too_large");
  assert.equal(errorCodeForStatus(422), "unprocessable");
  assert.equal(errorCodeForStatus(429), "rate_limited");
  assert.equal(errorCodeForStatus(500), "internal_error");
  assert.equal(errorCodeForStatus(503), "internal_error");
  assert.equal(errorCodeForStatus(418), "http_418");
});

test("pathWithoutQuery drops the query string and fragment", () => {
  assert.equal(pathWithoutQuery("/api/search?q=secret"), "/api/search");
  assert.equal(pathWithoutQuery("/api/x#frag"), "/api/x");
  assert.equal(pathWithoutQuery("/api/x"), "/api/x");
});

test("entityInPath finds the challenge/solution a numbered route targets", () => {
  assert.deepEqual(entityInPath("/api/challenges/[number]", "/api/challenges/412"), { kind: "challenge", number: 412 });
  assert.deepEqual(entityInPath("/api/challenges/[number]/solutions", "/api/challenges/CH-7/solutions"), { kind: "challenge", number: 7 });
  assert.deepEqual(entityInPath("/api/solutions/[number]/withdraw", "/api/solutions/88/withdraw"), { kind: "solution", number: 88 });
  assert.equal(entityInPath("/api/comments", "/api/comments"), null);
  assert.equal(entityInPath("/api/challenges/[number]", "/api/challenges/not-a-number"), null);
  assert.equal(entityInPath("/api/challenges/[number]", "/api/challenges"), null, "segment count mismatch");
  assert.equal(entityInPath("/api/notifications/[id]", "/api/notifications/abc"), null, "only [number] segments name an entity");
});

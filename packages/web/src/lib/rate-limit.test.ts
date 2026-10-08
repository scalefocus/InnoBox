// Unit tests for the §2.4 per-user token buckets (INNOBOX_SPEC.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { RATE_LIMITS, rateLimit, resetRateLimits, takeToken } from "./rate-limit";

test("a bucket allows exactly its limit, then refuses with a Retry-After", () => {
  resetRateLimits();
  const t0 = 1_800_000_000_000;
  for (let i = 0; i < RATE_LIMITS.create.limit; i++) {
    assert.deepEqual(takeToken("u1", "create", t0), { ok: true }, `request ${i + 1} allowed`);
  }
  const refused = takeToken("u1", "create", t0);
  assert.equal(refused.ok, false);
  // 30/hour refills one token every 120 s.
  if (!refused.ok) assert.equal(refused.retryAfterSeconds, 120);
});

test("tokens refill continuously over the window", () => {
  resetRateLimits();
  const t0 = 1_800_000_000_000;
  for (let i = 0; i < RATE_LIMITS.mutation.limit; i++) takeToken("u1", "mutation", t0);
  assert.equal(takeToken("u1", "mutation", t0).ok, false);
  // 120/min = one token every 500 ms.
  assert.equal(takeToken("u1", "mutation", t0 + 500).ok, true);
  assert.equal(takeToken("u1", "mutation", t0 + 500).ok, false);
});

test("buckets are per user and per bucket", () => {
  resetRateLimits();
  const t0 = 1_800_000_000_000;
  for (let i = 0; i < RATE_LIMITS.comment.limit; i++) takeToken("u1", "comment", t0);
  assert.equal(takeToken("u1", "comment", t0).ok, false);
  assert.equal(takeToken("u2", "comment", t0).ok, true, "another user is unaffected");
  assert.equal(takeToken("u1", "upload", t0).ok, true, "another bucket is unaffected");
});

test("rateLimit returns null when allowed and a 429 with Retry-After when not", async () => {
  resetRateLimits();
  const original = console.warn;
  console.warn = () => {};
  try {
    for (let i = 0; i < RATE_LIMITS.upload.limit; i++) assert.equal(rateLimit("u1", "upload"), null);
    const res = rateLimit("u1", "upload");
    assert.ok(res);
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("retry-after")) >= 1);
    assert.match(((await res.json()) as { error: string }).error, /too many requests/i);
  } finally {
    console.warn = original;
  }
});

// Unit tests for the §2.4 per-user token buckets (INNOBOX_SPEC.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { RATE_LIMITS, effectiveLimit, rateLimit, rateLimitWarning, resetRateLimits, takeToken } from "./rate-limit";

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

test("search is the one limited read: 120 per minute, its own bucket", () => {
  resetRateLimits();
  const t0 = 1_800_000_000_000;
  assert.deepEqual(RATE_LIMITS.search, { limit: 120, windowMs: 60_000 });
  for (let i = 0; i < 120; i++) assert.equal(takeToken("u1", "search", t0, 1).ok, true);
  assert.equal(takeToken("u1", "search", t0, 1).ok, false);
  assert.equal(takeToken("u1", "mutation", t0, 1).ok, true, "search does not drain the mutation bucket");
});

test("RATE_LIMIT_MULTIPLIER scales every bucket's limit", () => {
  resetRateLimits();
  const t0 = 1_800_000_000_000;
  assert.equal(effectiveLimit("create", 50), 1_500);
  assert.equal(effectiveLimit("create", 1), RATE_LIMITS.create.limit);
  for (let i = 0; i < RATE_LIMITS.create.limit * 2; i++) assert.equal(takeToken("u1", "create", t0, 2).ok, true);
  assert.equal(takeToken("u1", "create", t0, 2).ok, false);
});

test("survey: its own 10-per-minute bucket (§13.10)", () => {
  resetRateLimits();
  const t0 = 1_800_000_000_000;
  assert.deepEqual(RATE_LIMITS.survey, { limit: 10, windowMs: 60_000 });
  for (let i = 0; i < 10; i++) assert.equal(takeToken("u1", "survey", t0, 1).ok, true);
  assert.equal(takeToken("u1", "survey", t0, 1).ok, false);
  assert.equal(takeToken("u1", "mutation", t0, 1).ok, true, "the survey bucket does not drain mutation");
});

test("the survey routes' rate-limit warning omits the user id (§13.10)", () => {
  assert.deepEqual(rateLimitWarning("u1", "survey", true), { level: "warn", msg: "rate limit exceeded", bucket: "survey" });
  assert.equal(rateLimitWarning("u1", "mutation").userId, "u1", "every other route still names the user");
  resetRateLimits();
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (line: string) => lines.push(line);
  try {
    for (let i = 0; i <= effectiveLimit("survey"); i++) rateLimit("u-survey", "survey", { anonymous: true });
    assert.equal(lines.length, 1);
    assert.ok(!lines[0]!.includes("u-survey"), "no user id in the warning");
  } finally {
    console.warn = original;
  }
});

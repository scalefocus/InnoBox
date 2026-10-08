// Unit tests for the §2.4 rate limiter: the sliding window is exact, Retry-After is derived from
// the oldest hit still in the window, keys are independent, the multiplier is a non-production
// convenience only, and idle keys are swept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCIM_RATE_LIMIT, SlidingWindowLimiter, resolveRateLimitMultiplier, scaleRule } from "./ratelimit.js";

function clock(start = 1_800_000_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test("allows up to max hits in a window, then denies with a Retry-After", () => {
  const c = clock();
  const limiter = new SlidingWindowLimiter(c.now);
  const rule = { max: 3, windowMs: 60_000 };
  assert.deepEqual(limiter.check("u1", rule), { allowed: true, remaining: 2 });
  assert.deepEqual(limiter.check("u1", rule), { allowed: true, remaining: 1 });
  assert.deepEqual(limiter.check("u1", rule), { allowed: true, remaining: 0 });
  const denied = limiter.check("u1", rule);
  assert.equal(denied.allowed, false);
  if (!denied.allowed) assert.equal(denied.retryAfterSeconds, 60);
});

test("the window slides: capacity returns as the oldest hit ages out", () => {
  const c = clock();
  const limiter = new SlidingWindowLimiter(c.now);
  const rule = { max: 2, windowMs: 10_000 };
  limiter.check("u1", rule); // t=0
  c.advance(4_000);
  limiter.check("u1", rule); // t=4s
  c.advance(1_000);
  const denied = limiter.check("u1", rule); // t=5s — both hits inside the window
  assert.equal(denied.allowed, false);
  if (!denied.allowed) assert.equal(denied.retryAfterSeconds, 5, "the oldest hit (t=0) leaves the window at t=10s");
  c.advance(5_000); // t=10s — the t=0 hit has aged out (boundary is exclusive)
  assert.equal(limiter.check("u1", rule).allowed, true);
  assert.equal(limiter.check("u1", rule).allowed, false, "the t=4s hit is still inside");
});

test("Retry-After is never below one second", () => {
  const c = clock();
  const limiter = new SlidingWindowLimiter(c.now);
  const rule = { max: 1, windowMs: 1_500 };
  limiter.check("u1", rule);
  c.advance(1_400);
  const denied = limiter.check("u1", rule);
  assert.equal(denied.allowed, false);
  if (!denied.allowed) assert.equal(denied.retryAfterSeconds, 1);
});

test("keys are independent — one busy user never throttles another", () => {
  const limiter = new SlidingWindowLimiter(clock().now);
  const rule = { max: 1, windowMs: 60_000 };
  assert.equal(limiter.check("u1", rule).allowed, true);
  assert.equal(limiter.check("u1", rule).allowed, false);
  assert.equal(limiter.check("u2", rule).allowed, true);
});

test("idle keys are swept once enough checks have happened", () => {
  const c = clock();
  const limiter = new SlidingWindowLimiter(c.now);
  const rule = { max: 5, windowMs: 1_000 };
  for (let i = 0; i < 50; i++) limiter.check(`idle-${i}`, rule);
  assert.equal(limiter.size(), 50);
  c.advance(5_000); // every idle key is now fully outside its window
  for (let i = 0; i < 1_000; i++) limiter.check("busy", rule); // crosses the sweep threshold
  assert.equal(limiter.size(), 1, "only the live key survives the sweep");
});

test("reset forgets everything", () => {
  const limiter = new SlidingWindowLimiter(clock().now);
  limiter.check("u1", { max: 1, windowMs: 1_000 });
  limiter.reset();
  assert.equal(limiter.size(), 0);
  assert.equal(limiter.check("u1", { max: 1, windowMs: 1_000 }).allowed, true);
});

test("the multiplier is honoured only outside production and only when sane", () => {
  assert.equal(resolveRateLimitMultiplier("10", "production"), 1, "production ignores the variable");
  assert.equal(resolveRateLimitMultiplier("10", "development"), 10);
  assert.equal(resolveRateLimitMultiplier("10", "test"), 10);
  assert.equal(resolveRateLimitMultiplier("10", undefined), 10);
  assert.equal(resolveRateLimitMultiplier(undefined, "development"), 1);
  assert.equal(resolveRateLimitMultiplier("", "development"), 1);
  assert.equal(resolveRateLimitMultiplier("abc", "development"), 1);
  assert.equal(resolveRateLimitMultiplier("0.5", "development"), 1, "a multiplier below 1 would tighten limits — refused");
  assert.equal(resolveRateLimitMultiplier("-3", "development"), 1);
});

test("scaleRule multiplies the budget and leaves the window alone", () => {
  assert.deepEqual(scaleRule({ max: 10, windowMs: 1_000 }, 5), { max: 50, windowMs: 1_000 });
  assert.deepEqual(scaleRule({ max: 10, windowMs: 1_000 }, 1), { max: 10, windowMs: 1_000 });
});

test("the SCIM rule matches the spec", () => {
  assert.deepEqual(SCIM_RATE_LIMIT, { max: 2_000, windowMs: 900_000 });
});

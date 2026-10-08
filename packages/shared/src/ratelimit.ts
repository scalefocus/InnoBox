// Rate limiting helpers (INNOBOX_SPEC.md §2.4): the worker's SCIM per-IP rule, the pure
// sliding-window limiter that enforces it, and the RATE_LIMIT_MULTIPLIER resolver that both the
// worker and the web tier's per-user token buckets (packages/web/src/lib/rate-limit.ts) honour.
//
// The limits are CODE CONSTANTS — no admin UI, no platform setting. The counter store is
// in-memory per process, like the web buckets: correct for the single-instance v1. Pure and
// dependency-free so the worker and the unit tests share one implementation.

export interface RateLimitRule {
  /** Requests allowed per window. */
  max: number;
  /** Window length in milliseconds (sliding). */
  windowMs: number;
}

const MINUTE = 60_000;

/** The worker's SCIM endpoints, per client IP — sized so an initial Entra sync of a few thousand
 *  users never trips it (Entra honours 429 + Retry-After if it does). */
export const SCIM_RATE_LIMIT: RateLimitRule = { max: 2_000, windowMs: 15 * MINUTE };

/**
 * `RATE_LIMIT_MULTIPLIER` scales every limit for local dev and e2e, and is honoured ONLY when
 * `NODE_ENV !== "production"` — the same guard as the dev-auth bypass (§2.3, §2.4). Production always
 * resolves to 1 no matter what the variable says; so does any unparseable or sub-1 value.
 */
export function resolveRateLimitMultiplier(raw: string | undefined, nodeEnv: string | undefined): number {
  if (nodeEnv === "production") return 1;
  if (raw === undefined || raw.trim() === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

export function scaleRule(rule: RateLimitRule, multiplier: number): RateLimitRule {
  return { max: Math.ceil(rule.max * multiplier), windowMs: rule.windowMs };
}

export type RateLimitDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

/**
 * A sliding-window-log limiter: per key, the timestamps of the hits inside the current window.
 * Exact (no fixed-window burst at the boundary) and cheap at these volumes — the largest rule
 * keeps at most 2 000 timestamps per key. Keys that fall idle are swept opportunistically so a
 * long-running process never accumulates stale entries.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private checksSinceSweep = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  check(key: string, rule: RateLimitRule): RateLimitDecision {
    const nowMs = this.now();
    const floor = nowMs - rule.windowMs;
    let log = this.hits.get(key);
    if (log) {
      // Drop everything that has slid out of the window. Timestamps are appended in order,
      // so the stale prefix is contiguous.
      let drop = 0;
      while (drop < log.length && (log[drop] as number) <= floor) drop++;
      if (drop > 0) log.splice(0, drop);
    } else {
      log = [];
      this.hits.set(key, log);
    }

    this.maybeSweep(floor);

    if (log.length >= rule.max) {
      const oldest = log[0] as number;
      const retryAfterMs = oldest + rule.windowMs - nowMs;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    log.push(nowMs);
    return { allowed: true, remaining: rule.max - log.length };
  }

  /** Test seam / process housekeeping: forget every key. */
  reset(): void {
    this.hits.clear();
    this.checksSinceSweep = 0;
  }

  /** Number of keys currently tracked (for tests and diagnostics). */
  size(): number {
    return this.hits.size;
  }

  private maybeSweep(floor: number): void {
    if (++this.checksSinceSweep < 1_000) return;
    this.checksSinceSweep = 0;
    for (const [key, log] of this.hits) {
      const newest = log[log.length - 1];
      if (newest === undefined || newest <= floor) this.hits.delete(key);
    }
  }
}

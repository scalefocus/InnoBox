// Per-user rate limiting (INNOBOX_SPEC.md §2.4): token buckets held in the web process. v1 runs
// one web instance, so in-memory state is the whole picture; a restart resets the buckets,
// which is acceptable for an abuse brake. Rejections are LOGGED, never audited — a flood must
// not become an audit flood. (Like any web-tier 429 they still reach the §14.7 system log, which
// is operational telemetry, not the audit log.)
import { resolveRateLimitMultiplier } from "@innobox/shared";

export type RateLimitBucket = "create" | "comment" | "upload" | "search" | "mutation" | "csp-report";

/** §2.4 limits: `limit` requests per `windowMs`, refilled continuously. */
export const RATE_LIMITS: Record<RateLimitBucket, { limit: number; windowMs: number }> = {
  create: { limit: 30, windowMs: 60 * 60 * 1000 }, // challenge or solution create
  comment: { limit: 60, windowMs: 60 * 60 * 1000 },
  upload: { limit: 60, windowMs: 60 * 60 * 1000 }, // single-shot or chunked initiate
  search: { limit: 120, windowMs: 60 * 1000 }, // search, autocomplete, the §6.1 similarity check
  mutation: { limit: 120, windowMs: 60 * 1000 }, // every other state-changing request
  // The public CSP report sink — keyed per client IP, not per user (there is none), and taken
  // via takeToken() directly: its 429s are not logged individually (app/api/csp-report).
  "csp-report": { limit: 120, windowMs: 60 * 1000 },
};

/** RATE_LIMIT_MULTIPLIER scales every limit for local dev and e2e; a production build ignores it
 *  (the dev-auth guard, §2.3). Resolved once per process. */
const MULTIPLIER = resolveRateLimitMultiplier(process.env.RATE_LIMIT_MULTIPLIER, process.env.NODE_ENV);

/** The limit actually enforced for `bucket` under `multiplier`. */
export function effectiveLimit(bucket: RateLimitBucket, multiplier: number = MULTIPLIER): number {
  return Math.ceil(RATE_LIMITS[bucket].limit * multiplier);
}

interface BucketState {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, BucketState>();

/** Bounds the map: entries idle long enough to have fully refilled carry no information. */
const MAX_TRACKED = 50_000;

export type RateLimitDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

/** Take one token from `userId`'s `bucket`, or report how long until one is available. */
export function takeToken(
  userId: string,
  bucket: RateLimitBucket,
  now: number = Date.now(),
  multiplier: number = MULTIPLIER,
): RateLimitDecision {
  const { windowMs } = RATE_LIMITS[bucket];
  const limit = effectiveLimit(bucket, multiplier);
  const refillPerMs = limit / windowMs;
  const key = `${bucket}:${userId}`;

  const prev = buckets.get(key);
  const tokens = prev ? Math.min(limit, prev.tokens + (now - prev.updatedAt) * refillPerMs) : limit;

  if (tokens < 1) {
    buckets.set(key, { tokens, updatedAt: now });
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1000)) };
  }
  if (!prev && buckets.size >= MAX_TRACKED) pruneFull(now, multiplier);
  buckets.set(key, { tokens: tokens - 1, updatedAt: now });
  return { ok: true };
}

function pruneFull(now: number, multiplier: number): void {
  for (const [key, state] of buckets) {
    const bucket = key.slice(0, key.indexOf(":")) as RateLimitBucket;
    const { windowMs } = RATE_LIMITS[bucket];
    const limit = effectiveLimit(bucket, multiplier);
    if (state.tokens + (now - state.updatedAt) * (limit / windowMs) >= limit) buckets.delete(key);
  }
}

/** For route handlers: null when allowed, else the 429 response to return. */
export function rateLimit(userId: string, bucket: RateLimitBucket): Response | null {
  const decision = takeToken(userId, bucket);
  if (decision.ok) return null;
  console.warn(JSON.stringify({ level: "warn", msg: "rate limit exceeded", userId, bucket }));
  return Response.json(
    { error: "Too many requests — try again shortly." },
    { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } },
  );
}

/** Test hook. */
export function resetRateLimits(): void {
  buckets.clear();
}

// Per-user rate limiting (INNOBOX_SPEC.md §2.4): token buckets held in the web process. v1 runs
// one web instance, so in-memory state is the whole picture; a restart resets the buckets,
// which is acceptable for an abuse brake. Rejections are LOGGED, never audited — a flood must
// not become an audit flood. (Like any web-tier 429 they still reach the §14.7 system log, which
// is operational telemetry, not the audit log.)
import { resolveRateLimitMultiplier } from "@innobox/shared";

export type RateLimitBucket =
  | "create"
  | "comment"
  | "upload"
  | "search"
  | "download"
  | "mutation"
  | "survey"
  | "bug_report"
  | "bug_report_day"
  | "csp-report"
  | "public-read"
  | "public-submit"
  | "public-confirm"
  | "mcp-register"
  | "mcp-ip";

/** §2.4 limits: `limit` requests per `windowMs`, refilled continuously. */
export const RATE_LIMITS: Record<RateLimitBucket, { limit: number; windowMs: number }> = {
  create: { limit: 30, windowMs: 60 * 60 * 1000 }, // challenge or solution create
  comment: { limit: 60, windowMs: 60 * 60 * 1000 },
  upload: { limit: 60, windowMs: 60 * 60 * 1000 }, // single-shot or chunked initiate
  search: { limit: 120, windowMs: 60 * 1000 }, // search, autocomplete, the §6.1 similarity check
  // §11 attachment download gateway: every denial is an audit row, so the GET is the other
  // limited read — a loop over made-up ids must not become an audit flood.
  download: { limit: 120, windowMs: 60 * 1000 },
  mutation: { limit: 120, windowMs: 60 * 1000 }, // every other state-changing request
  survey: { limit: 10, windowMs: 60 * 1000 }, // survey start + submit (§13.10)
  // A bug report (§13.10): 3 a minute AND 20 a day — the route takes a token from both.
  bug_report: { limit: 3, windowMs: 60 * 1000 },
  bug_report_day: { limit: 20, windowMs: 24 * 60 * 60 * 1000 },
  // The public CSP report sink — keyed per client IP, not per user (there is none), and taken
  // via takeToken() directly: its 429s are not logged individually (app/api/csp-report).
  "csp-report": { limit: 120, windowMs: 60 * 1000 },
  // §25.11 agent access, keyed per client IP: dynamic client registration, and /oauth/token plus
  // unauthenticated /mcp calls. Taken via takeToken() directly by those routes.
  "mcp-register": { limit: 10, windowMs: 60 * 60 * 1000 },
  "mcp-ip": { limit: 60, windowMs: 60 * 1000 },
  // §24.4 the public submission routes — per client IP too, and taken via takeToken() directly:
  // their 429s are counted by innobox_public_submissions_total, not logged or system-logged.
  "public-read": { limit: 30, windowMs: 60 * 1000 }, // GET /api/public/pow and /api/public/settings
  "public-submit": { limit: 5, windowMs: 60 * 60 * 1000 }, // POST /api/public/submissions
  "public-confirm": { limit: 20, windowMs: 60 * 60 * 1000 }, // POST /api/public/confirm
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

/** A store entry: the bucket's state, linked into the recency list. */
interface Entry extends BucketState {
  key: string;
  older: Entry | null;
  newer: Entry | null;
}

/** One store for every bucket, per-user and per-IP: a Map for lookup plus a doubly linked
 *  recency list (`oldest` … `newest`), so moving or evicting an entry never iterates. (Taking the
 *  first key of a Map is not constant time under churn: deleted slots are skipped one by one.) */
const buckets = new Map<string, Entry>();
let oldest: Entry | null = null;
let newest: Entry | null = null;

/** §2.4 bucket store bound: at most this many keys. A new key beyond it evicts the least recently
 *  used one in constant time, so memory stays bounded however many addresses a flood comes from,
 *  and no request ever scans the store. Forgetting a bucket can only hand a caller a fresh
 *  allowance, never refuse one. */
export const MAX_TRACKED = 50_000;

function unlink(e: Entry): void {
  if (e.older) e.older.newer = e.newer;
  else oldest = e.newer;
  if (e.newer) e.newer.older = e.older;
  else newest = e.older;
  e.older = e.newer = null;
}

function append(e: Entry): void {
  e.older = newest;
  e.newer = null;
  if (newest) newest.newer = e;
  else oldest = e;
  newest = e;
}

/** Records `key`'s new state and marks it the most recently used. */
function touch(key: string, tokens: number, updatedAt: number): void {
  const existing = buckets.get(key);
  if (existing) {
    existing.tokens = tokens;
    existing.updatedAt = updatedAt;
    if (existing !== newest) {
      unlink(existing);
      append(existing);
    }
    return;
  }
  if (buckets.size >= MAX_TRACKED && oldest) {
    buckets.delete(oldest.key);
    unlink(oldest);
  }
  const entry: Entry = { key, tokens, updatedAt, older: null, newer: null };
  buckets.set(key, entry);
  append(entry);
}

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
    touch(key, tokens, now);
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1000)) };
  }
  touch(key, tokens - 1, now);
  return { ok: true };
}

/** Test hook: how many keys the store holds. */
export function trackedBucketCount(): number {
  return buckets.size;
}

/** The warning line for a refused request. `anonymous` drops the user id: the survey routes'
 *  refusals must not put a named, exact-time line next to a date-only response (§13.10). */
export function rateLimitWarning(userId: string, bucket: RateLimitBucket, anonymous = false): Record<string, unknown> {
  return anonymous ? { level: "warn", msg: "rate limit exceeded", bucket } : { level: "warn", msg: "rate limit exceeded", userId, bucket };
}

/** For route handlers: null when allowed, else the 429 response to return. Pass
 *  `{ anonymous: true }` from the survey routes so the warning carries no user id. */
export function rateLimit(userId: string, bucket: RateLimitBucket, opts: { anonymous?: boolean } = {}): Response | null {
  const decision = takeToken(userId, bucket);
  if (decision.ok) return null;
  console.warn(JSON.stringify(rateLimitWarning(userId, bucket, opts.anonymous)));
  return Response.json(
    { error: "Too many requests — try again shortly." },
    { status: 429, headers: { "Retry-After": String(decision.retryAfterSeconds) } },
  );
}

/** §25.11: the per-(person, client) bucket allows this share of the person's own limit, so one
 *  runaway agent cannot use up the person's allowance on its own. */
export const MCP_CLIENT_SHARE = 0.5;

/**
 * §25.11: an MCP tool call takes a token from the person's bucket — the same one their browser
 * requests draw on, so an agent gets no more throughput than the person — AND from the
 * (person, client) bucket. The first refusal wins.
 */
export function takeMcpToken(userId: string, clientRowId: string, bucket: RateLimitBucket, now: number = Date.now()): RateLimitDecision {
  const person = takeToken(userId, bucket, now);
  if (!person.ok) return person;
  return takeToken(`${userId}:mcp:${clientRowId}`, bucket, now, MULTIPLIER * MCP_CLIENT_SHARE);
}

/** Test hook. */
export function resetRateLimits(): void {
  buckets.clear();
  oldest = newest = null;
}

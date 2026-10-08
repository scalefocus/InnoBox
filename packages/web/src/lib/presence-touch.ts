// The presence WRITE path (INNOBOX_SPEC.md §14.5). Called from getSessionUser() on every
// authenticated request; does nothing unless the request is on the allowlist in
// lib/presence.ts. Three properties matter more than the data itself:
//
//   1. It NEVER fails the request it rides on. Every error is swallowed — presence is
//      telemetry, and a locked row or a missing column must not 500 a challenge page.
//   2. It never adds latency: the UPDATE is fired and not awaited.
//   3. It is throttled to one write per user per 60 s in-process, so a page that fans out
//      to six API calls costs one write, not six.
//
// Middleware is edge-runtime and does no DB work (ENTRA_AUTH_SPEC.md §5), which is why the
// stamp lives here, at the node layer, and why the pathname arrives via a request header
// that middleware injects.
import type { Pool } from "pg";
import { PRESENCE_THROTTLE_MS, presenceTouchFor } from "./presence";

/** Header middleware injects so the node layer knows which route it is serving. Next gives
 *  route handlers no built-in access to the matched pathname. */
export const PRESENCE_PATH_HEADER = "x-innobox-path";
export const PRESENCE_METHOD_HEADER = "x-innobox-method";

// Per-process throttle. Bounded implicitly by the active-user count over a 60 s window; the
// sweep below keeps it from holding entries for users who left hours ago. A multi-instance
// deployment throttles per instance, which only means *more* precision, never less.
const lastWriteAt = new Map<string, number>();

function throttled(userId: string, nowMs: number): boolean {
  const previous = lastWriteAt.get(userId);
  if (previous !== undefined && nowMs - previous < PRESENCE_THROTTLE_MS) return true;
  lastWriteAt.set(userId, nowMs);
  if (lastWriteAt.size > 5_000) {
    for (const [id, at] of lastWriteAt) {
      if (nowMs - at >= PRESENCE_THROTTLE_MS) lastWriteAt.delete(id);
    }
  }
  return false;
}

/** Test seam: the throttle is process-global, so suites must be able to reset it. */
export function resetPresenceThrottle(): void {
  lastWriteAt.clear();
}

/**
 * Stamps `users.last_seen_at` (and `last_route`, for a "locate" tier request) if the path is
 * on the allowlist and the user is outside the throttle window. Returns what it decided, so
 * tests can assert the decision without a database; the write itself is fire-and-forget.
 */
export function touchPresence(
  pool: Pool,
  userId: string,
  pathname: string | null,
  method: string | null,
  nowMs: number = Date.now(),
): "skipped" | "throttled" | "written" {
  if (!pathname) return "skipped";
  const touch = presenceTouchFor(pathname, (method ?? "GET").toUpperCase());
  if (!touch) return "skipped";
  if (throttled(userId, nowMs)) return "throttled";

  // A "touch" tier request leaves last_route alone (coalesce keeps the current value), so
  // liking a challenge doesn't move the user "nowhere" mid-read.
  const route = touch.tier === "locate" ? touch.route : null;
  void pool
    .query(
      `with stamped as (
         update users
            set last_seen_at = now(),
                last_route   = coalesce($2, last_route)
          where id = $1 and active and scrubbed_at is null
         returning id
       )
       insert into user_activity_days (user_id, day)
       select id, (now() at time zone 'utc')::date from stamped
       on conflict (user_id, day) do nothing`,
      [userId, route],
    )
    .catch(() => {
      // Deliberately silent: see property 1 above. A presence write that logged on every
      // failure would also be a log-flood vector during a database blip.
    });
  return "written";
}

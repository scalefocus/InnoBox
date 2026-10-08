// §14.10 (INNOBOX_SPEC.md): the "last SCIM request" stamp behind the identity-sync card. The SCIM
// router calls the stamper on every request that PASSED the bearer-token check (any method, any
// outcome). It writes `platform_settings.scim_last_request_at` at most once per 60 s per worker
// process and is fire-and-forget: the write is never awaited and a failed stamp never touches the
// SCIM response.
import type { Pool } from "pg";
import { SCIM_LAST_REQUEST_AT_KEY, SCIM_LAST_REQUEST_STAMP_INTERVAL_MS } from "@innobox/shared";

export async function writeScimLastRequestAt(pool: Pool, at: Date): Promise<void> {
  await pool.query(
    `insert into platform_settings (key, value, updated_at) values ($1, to_jsonb($2::text), now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [SCIM_LAST_REQUEST_AT_KEY, at.toISOString()],
  );
}

export interface ScimLastRequestStamperOptions {
  intervalMs?: number;
  now?: () => number;
  write?: (pool: Pool, at: Date) => Promise<void>;
}

/** Returns the per-process throttled stamper. The throttle window starts at the attempt, not at
 *  a successful write, so a failing database is not hammered by every SCIM call either. */
export function createScimLastRequestStamper(pool: Pool, opts: ScimLastRequestStamperOptions = {}): () => void {
  const intervalMs = opts.intervalMs ?? SCIM_LAST_REQUEST_STAMP_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const write = opts.write ?? writeScimLastRequestAt;
  let lastAttemptMs: number | null = null;
  return () => {
    const t = now();
    if (lastAttemptMs !== null && t - lastAttemptMs < intervalMs) return;
    lastAttemptMs = t;
    try {
      void write(pool, new Date(t)).catch(() => {
        /* telemetry never fails the request */
      });
    } catch {
      /* a synchronous throw is swallowed too */
    }
  };
}

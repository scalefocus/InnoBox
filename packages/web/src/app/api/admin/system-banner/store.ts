// Data layer for the §14.6 system banner (INNOBOX_SPEC.md): one `platform_settings` key holding
// `{ message, tone, url, expiresAt }`. Set/replace is an unconditional upsert whose countdown
// always restarts from the save; clear removes it immediately; expiry is lazy — every reader
// judges `expiresAt > now()` at read time, so no worker sweep exists and the row may linger
// (inert) until the next save. Deliberately NOT built on the notifications/outbox pipeline.
// Relative imports only (no `@/`) so the gated .dbtest.ts suite runs under the plain node runner.
import type { Pool } from "pg";
import {
  SYSTEM_BANNER_DURATION_HOURS,
  isSystemBannerActive,
  isSystemBannerTone,
  type SystemBanner,
  type SystemBannerInput,
} from "@innobox/shared";
import { appendAudit } from "../../../../lib/audit";

export const SYSTEM_BANNER_KEY = "system_banner";

function parseStored(value: unknown): SystemBanner | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.message !== "string" || typeof v.expiresAt !== "string") return null;
  return {
    message: v.message,
    tone: isSystemBannerTone(v.tone) ? v.tone : "info",
    url: typeof v.url === "string" && v.url !== "" ? v.url : null,
    expiresAt: v.expiresAt,
  };
}

/** The stored banner regardless of expiry (the admin card shows "expired" state from it). */
export async function getStoredSystemBanner(pool: Pool): Promise<SystemBanner | null> {
  const { rows } = await pool.query<{ value: unknown }>(`select value from platform_settings where key = $1`, [SYSTEM_BANNER_KEY]);
  return parseStored(rows[0]?.value);
}

/** The ACTIVE banner — null once expired, even while the row still exists (lazy expiry). */
export async function getActiveSystemBanner(pool: Pool, nowMs: number = Date.now()): Promise<SystemBanner | null> {
  const stored = await getStoredSystemBanner(pool);
  return isSystemBannerActive(stored, nowMs) ? stored : null;
}

/** Unconditional upsert: text, tone, link and duration replace whatever is active and the
 *  countdown restarts from now. Audited `system_banner.set`. */
export async function setSystemBanner(pool: Pool, input: SystemBannerInput, actorUserId: string, nowMs: number = Date.now()): Promise<SystemBanner> {
  const hours = SYSTEM_BANNER_DURATION_HOURS[input.duration];
  const banner: SystemBanner = {
    message: input.message,
    tone: input.tone,
    url: input.url,
    expiresAt: new Date(nowMs + hours * 3_600_000).toISOString(),
  };
  await pool.query(
    `insert into platform_settings (key, value, updated_by, updated_at)
     values ($1, $2::jsonb, $3, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [SYSTEM_BANNER_KEY, JSON.stringify(banner), actorUserId],
  );
  await appendAudit(pool, {
    actorUserId,
    action: "system_banner.set",
    targetType: "platform_settings",
    targetId: SYSTEM_BANNER_KEY,
    after: { message: banner.message, tone: banner.tone, url: banner.url, duration: input.duration, expiresAt: banner.expiresAt },
  });
  return banner;
}

/** Removes the banner immediately (before natural expiry). Audited `system_banner.cleared`.
 *  Returns false when nothing was stored. */
export async function clearSystemBanner(pool: Pool, actorUserId: string): Promise<boolean> {
  const before = await getStoredSystemBanner(pool);
  // No DELETE grant on platform_settings — the key is emptied in place (a null value parses as
  // "no banner"), which is all lazy expiry needs anyway.
  await pool.query(
    `insert into platform_settings (key, value, updated_by, updated_at)
     values ($1, 'null'::jsonb, $2, now())
     on conflict (key) do update set value = 'null'::jsonb, updated_by = excluded.updated_by, updated_at = now()`,
    [SYSTEM_BANNER_KEY, actorUserId],
  );
  await appendAudit(pool, {
    actorUserId,
    action: "system_banner.cleared",
    targetType: "platform_settings",
    targetId: SYSTEM_BANNER_KEY,
    before: before ? { message: before.message, expiresAt: before.expiresAt } : null,
  });
  return before !== null;
}

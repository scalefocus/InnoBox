// The §26.8 platform switch for hype (INNOBOX_SPEC.md §26.8): one key in platform_settings, off
// by default (migration 0050). Read on every hype surface; written only by the admin settings
// store, which audits the change.
// Relative imports only (no `@/`) so the gated dbtests can load it.
import type { Pool, PoolClient } from "pg";

export const HYPE_ENABLED_KEY = "hype_enabled";

/** True only when the stored value is exactly `true` — a missing or malformed row is off. */
export async function getHypeEnabled(db: Pool | PoolClient): Promise<boolean> {
  const { rows } = await db.query<{ value: unknown }>(`select value from platform_settings where key = $1`, [HYPE_ENABLED_KEY]);
  return rows[0]?.value === true;
}

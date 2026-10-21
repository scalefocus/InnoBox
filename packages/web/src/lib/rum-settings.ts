// The §14.12 real-user-monitoring switch and sample rate (INNOBOX_SPEC.md): two keys in
// platform_settings, off and 100 % by default (migration 0052). Read by `GET /api/me` (the
// collector's start decision) and by the beacon endpoint (which discards everything while off);
// written only from the monitoring page, audited as `settings.telemetry_changed`.
// Relative imports only (no `@/`) so the gated dbtests can load it.
import type { Pool, PoolClient } from "pg";
import { RUM_ENABLED_KEY, RUM_SAMPLE_RATE_KEY, coerceRumSampleRate, type RumSampleRate } from "@innobox/shared/rum";
import { appendAudit } from "./audit";
import { inTransaction } from "./db";

export interface RumSettings {
  enabled: boolean;
  sampleRate: RumSampleRate;
}

/** A missing or malformed switch reads as off; a malformed rate as 100. */
export async function getRumSettings(db: Pool | PoolClient): Promise<RumSettings> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    `select key, value from platform_settings where key = any($1::text[])`,
    [[RUM_ENABLED_KEY, RUM_SAMPLE_RATE_KEY]],
  );
  const value = (key: string) => rows.find((r) => r.key === key)?.value;
  return { enabled: value(RUM_ENABLED_KEY) === true, sampleRate: coerceRumSampleRate(value(RUM_SAMPLE_RATE_KEY)) };
}

/** Applies a validated patch and writes one audit row with the resulting pair, in one transaction.
 *  A patch that changes nothing writes nothing. */
export async function setRumSettings(
  pool: Pool,
  patch: Partial<RumSettings>,
  actorUserId: string,
): Promise<RumSettings> {
  return inTransaction(pool, async (client) => {
    const before = await getRumSettings(client);
    const after: RumSettings = { enabled: patch.enabled ?? before.enabled, sampleRate: patch.sampleRate ?? before.sampleRate };
    if (after.enabled === before.enabled && after.sampleRate === before.sampleRate) return before;
    for (const [key, value] of [
      [RUM_ENABLED_KEY, after.enabled],
      [RUM_SAMPLE_RATE_KEY, after.sampleRate],
    ] as const) {
      await client.query(
        `insert into platform_settings (key, value, updated_by, updated_at)
         values ($1, $2::jsonb, $3, now())
         on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
        [key, JSON.stringify(value), actorUserId],
      );
    }
    await appendAudit(client, {
      actorUserId,
      action: "settings.telemetry_changed",
      targetType: "platform_settings",
      targetId: RUM_ENABLED_KEY,
      before: { enabled: before.enabled, sampleRate: before.sampleRate },
      after: { enabled: after.enabled, sampleRate: after.sampleRate },
    });
    return after;
  });
}

// The §14.7 alert sweep (INNOBOX_SPEC.md): every 5 minutes, leader-only, post a COALESCED
// `system_error` inbox row to each platform admin when new system-log events have appeared —
// one unread item per admin whose count accumulates until read, watermarked in
// platform_settings.system_log_notify_at so nothing is double-counted. In-app only: no
// notification_outbox row is ever written, so the e-mail sweep never sees it, and the §12.1
// per-event preferences do not apply.
import type { Pool } from "pg";

export const SYSTEM_LOG_NOTIFY_WATERMARK_KEY = "system_log_notify_at";
export const SYSTEM_ERROR_NOTIFICATION_TYPE = "system_error";
export const SYSTEM_LOG_LINK = "/admin/system-log";

export interface SystemLogAlertSummary {
  newEvents: number;
  adminsNotified: number;
}

export function systemErrorMessage(count: number): string {
  return `${count} new system log event${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} a look.`;
}

/** Platform admins resolved the only way roles ever are (invariant 1): SCIM-synced group
 *  membership + role_mappings, plus the bootstrap group while it is configured. Active users only. */
async function platformAdminIds(pool: Pool, bootstrapAdminGroup: string | undefined): Promise<string[]> {
  const { rows } = await pool.query<{ user_id: string }>(
    `select distinct gm.user_id
       from group_members gm
       join groups g on g.id = gm.group_id
       join users u on u.id = gm.user_id and u.active and u.scrubbed_at is null
      where exists (select 1 from role_mappings rm where rm.group_external_id = g.external_id and rm.role = 'platform_admin')
         or ($1::text is not null and g.external_id = $1)`,
    [bootstrapAdminGroup ?? null],
  );
  return rows.map((r) => r.user_id);
}

export async function runSystemLogAlertSweep(pool: Pool, opts: { bootstrapAdminGroup?: string } = {}): Promise<SystemLogAlertSummary> {
  const summary: SystemLogAlertSummary = { newEvents: 0, adminsNotified: 0 };

  // The watermark round-trips as Postgres's own timestamptz text (microsecond precision): a
  // JavaScript Date would truncate to milliseconds and re-count the rows inside the lost digits.
  const { rows: wm } = await pool.query<{ value: unknown }>(`select value from platform_settings where key = $1`, [SYSTEM_LOG_NOTIFY_WATERMARK_KEY]);
  const watermark = typeof wm[0]?.value === "string" && Number.isFinite(Date.parse(wm[0].value)) ? wm[0].value : null;

  const { rows: counted } = await pool.query<{ count: string; latest: string | null }>(
    `select count(*)::text as count, max(created_at)::text as latest
       from system_events
      where created_at > coalesce($1::timestamptz, '-infinity'::timestamptz)`,
    [watermark],
  );
  const count = Number(counted[0]?.count ?? 0);
  const latest = counted[0]?.latest ?? null;
  if (count === 0 || !latest) return summary;
  summary.newEvents = count;

  for (const adminId of await platformAdminIds(pool, opts.bootstrapAdminGroup)) {
    const { rows: existing } = await pool.query<{ id: string; payload: { count?: unknown } }>(
      `select id, payload from notifications where user_id = $1 and type = $2 and read_at is null order by created_at desc limit 1`,
      [adminId, SYSTEM_ERROR_NOTIFICATION_TYPE],
    );
    const current = existing[0];
    const total = count + (typeof current?.payload.count === "number" ? current.payload.count : 0);
    const payload = JSON.stringify({ message: systemErrorMessage(total), link: SYSTEM_LOG_LINK, count: total });
    if (current) {
      // Coalesce: refresh the one unread row in place (count, message, and re-sort to the top).
      await pool.query(`update notifications set payload = $2::jsonb, created_at = now() where id = $1`, [current.id, payload]);
    } else {
      await pool.query(`insert into notifications (user_id, type, payload) values ($1, $2, $3::jsonb)`, [adminId, SYSTEM_ERROR_NOTIFICATION_TYPE, payload]);
    }
    summary.adminsNotified += 1;
  }

  await pool.query(
    `insert into platform_settings (key, value, updated_at) values ($1, to_jsonb($2::text), now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [SYSTEM_LOG_NOTIFY_WATERMARK_KEY, latest],
  );
  return summary;
}

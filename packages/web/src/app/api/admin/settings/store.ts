// Data layer for /api/admin/settings (INNOBOX_SPEC.md §14.3): attachment limits, impact
// areas, and the platform date-display format. Namespace management and role mappings
// already live under /api/admin/namespaces and /api/admin/role-mappings (Phase 1); the
// notification sender (Graph connect flow) lives under /api/admin/email, reusing the
// carried-over lib/email.ts helpers. Every change here is audited (platform-admin only).
import type { Pool } from "pg";
import { isDateFormat, type DateFormat } from "@innobox/shared";
import { appendAudit } from "../../../../lib/audit";
import { inTransaction } from "../../../../lib/db";

// ── Date format ──────────────────────────────────────────────────────────────────────────

const DATE_FORMAT_KEY = "date_format";

export async function getDateFormat(pool: Pool): Promise<DateFormat> {
  const { rows } = await pool.query<{ value: unknown }>(`select value from platform_settings where key = $1`, [DATE_FORMAT_KEY]);
  const value = rows[0]?.value;
  if (typeof value === "string" && isDateFormat(value)) return value;
  return "eu";
}

export async function setDateFormat(pool: Pool, format: DateFormat, actorUserId: string): Promise<void> {
  await pool.query(
    `insert into platform_settings (key, value, updated_by, updated_at)
     values ($1, $2::jsonb, $3, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [DATE_FORMAT_KEY, JSON.stringify(format), actorUserId],
  );
  await appendAudit(pool, {
    actorUserId,
    action: "settings.date_format_changed",
    targetType: "platform_settings",
    targetId: DATE_FORMAT_KEY,
    after: { format },
  });
}

// ── Attachment limits ────────────────────────────────────────────────────────────────────

const ATTACHMENT_LIMITS_KEY = "attachment_limits";

export interface AttachmentLimits {
  maxPerItem: number;
  maxUploadSizeMb: number;
  /** Files larger than this (MB) are sliced and uploaded chunk-by-chunk (§11). Floor 5 MB (the
   *  S3 multipart part minimum), capped at `maxUploadSizeMb`. */
  chunkSizeMb: number;
}

const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = { maxPerItem: 5, maxUploadSizeMb: 10, chunkSizeMb: 5 };

export async function getAttachmentLimits(pool: Pool): Promise<AttachmentLimits> {
  const { rows } = await pool.query<{ value: Partial<AttachmentLimits> }>(`select value from platform_settings where key = $1`, [ATTACHMENT_LIMITS_KEY]);
  const value = rows[0]?.value;
  if (value && typeof value.maxPerItem === "number" && typeof value.maxUploadSizeMb === "number") {
    // `chunkSizeMb` was added later — default it for rows written before this change.
    const chunkSizeMb = typeof value.chunkSizeMb === "number" ? value.chunkSizeMb : DEFAULT_ATTACHMENT_LIMITS.chunkSizeMb;
    return { maxPerItem: value.maxPerItem, maxUploadSizeMb: value.maxUploadSizeMb, chunkSizeMb };
  }
  return DEFAULT_ATTACHMENT_LIMITS;
}

export async function setAttachmentLimits(pool: Pool, limits: AttachmentLimits, actorUserId: string): Promise<void> {
  await pool.query(
    `insert into platform_settings (key, value, updated_by, updated_at)
     values ($1, $2::jsonb, $3, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [ATTACHMENT_LIMITS_KEY, JSON.stringify(limits), actorUserId],
  );
  await appendAudit(pool, {
    actorUserId,
    action: "settings.attachment_limits_changed",
    targetType: "platform_settings",
    targetId: ATTACHMENT_LIMITS_KEY,
    after: limits,
  });
}

// ── Impact areas (§5, §14.3: add / rename / retire / delete) ────────────────────────────

export interface ImpactAreaRecord {
  id: string;
  name: string;
  active: boolean;
}

/** List row: the record plus the number of challenges referencing it, so the settings UI can
 *  render the "N challenges still use this area" tooltip and gate the Delete control (§14.3). */
export interface ImpactAreaListItem extends ImpactAreaRecord {
  challengeCount: number;
}

export async function listAllImpactAreas(pool: Pool): Promise<ImpactAreaListItem[]> {
  const { rows } = await pool.query<ImpactAreaListItem>(
    `select ia.id, ia.name, ia.active,
            (select count(*)::int from challenges c where c.impact_area_id = ia.id) as "challengeCount"
       from impact_areas ia
       order by ia.name`,
  );
  return rows;
}

export type CreateImpactAreaResult = { status: "ok"; area: ImpactAreaRecord } | { status: "duplicate" };

export async function createImpactArea(pool: Pool, name: string, actorUserId: string): Promise<CreateImpactAreaResult> {
  const { rows } = await pool.query<ImpactAreaRecord>(
    `insert into impact_areas (name) values ($1) on conflict (name) do nothing returning id, name, active`,
    [name],
  );
  const row = rows[0];
  if (!row) return { status: "duplicate" };
  await appendAudit(pool, {
    actorUserId,
    action: "impact_area.created",
    targetType: "impact_area",
    targetId: row.id,
    after: { name: row.name },
  });
  return { status: "ok", area: row };
}

export type PatchImpactAreaResult = { status: "ok"; area: ImpactAreaRecord } | { status: "not_found" } | { status: "duplicate" };

export async function patchImpactArea(
  pool: Pool,
  id: string,
  patch: { name?: string; active?: boolean },
  actorUserId: string,
): Promise<PatchImpactAreaResult> {
  const { rows: current } = await pool.query<ImpactAreaRecord>(`select id, name, active from impact_areas where id = $1`, [id]);
  const row = current[0];
  if (!row) return { status: "not_found" };

  if (patch.name !== undefined && patch.name !== row.name) {
    const { rows: renamed } = await pool.query<ImpactAreaRecord>(
      `update impact_areas set name = $2 where id = $1 and not exists (select 1 from impact_areas where name = $2 and id <> $1) returning id, name, active`,
      [id, patch.name],
    );
    if (!renamed[0]) return { status: "duplicate" };
    await appendAudit(pool, {
      actorUserId,
      action: "impact_area.renamed",
      targetType: "impact_area",
      targetId: id,
      before: { name: row.name },
      after: { name: patch.name },
    });
    row.name = patch.name;
  }

  if (patch.active !== undefined && patch.active !== row.active) {
    await pool.query(`update impact_areas set active = $2 where id = $1`, [id, patch.active]);
    await appendAudit(pool, {
      actorUserId,
      action: patch.active ? "impact_area.reactivated" : "impact_area.retired",
      targetType: "impact_area",
      targetId: id,
      before: { active: row.active },
      after: { active: patch.active },
    });
    row.active = patch.active;
  }

  return { status: "ok", area: row };
}

export type DeleteImpactAreaResult =
  | { status: "ok" }
  | { status: "not_found" }
  | { status: "not_retired" } // only a retired area may be deleted (§14.3)
  | { status: "has_references" } // challenges still reference it and no reassignment target was given
  | { status: "target_not_found" } // reassignToId doesn't resolve to an area
  | { status: "invalid_target" }; // target is the same area, inactive, or Client (§14.3)

/** Delete a **retired** impact area (§5, §14.3), platform-admin only, all in one transaction.
 *  If challenges still reference it, `reassignToId` must name another **active, non-Client** area:
 *  every referencing challenge is moved there and its `client_name` cleared (a client name is
 *  meaningless off Client, §5) before the row is deleted. With references but no target, the
 *  delete is rejected — never a silent partial action. Each moved challenge is audited as a
 *  `challenge.edited` diff, and the delete itself as `impact_area.deleted` (§15). Race-safe: the
 *  area row is locked FOR UPDATE, and a retired area can never gain a new reference (submission
 *  requires an active area, §6.1). */
export async function deleteImpactArea(
  pool: Pool,
  id: string,
  reassignToId: string | null,
  actorUserId: string,
): Promise<DeleteImpactAreaResult> {
  return inTransaction(pool, async (client) => {
    const { rows: areaRows } = await client.query<ImpactAreaRecord>(
      `select id, name, active from impact_areas where id = $1 for update`,
      [id],
    );
    const area = areaRows[0];
    if (!area) return { status: "not_found" };
    if (area.active) return { status: "not_retired" };

    // Validate the reassignment target up front (when supplied): a different, active, non-Client area.
    let target: ImpactAreaRecord | null = null;
    if (reassignToId !== null) {
      if (reassignToId === id) return { status: "invalid_target" };
      const { rows: t } = await client.query<ImpactAreaRecord>(`select id, name, active from impact_areas where id = $1`, [reassignToId]);
      target = t[0] ?? null;
      if (!target) return { status: "target_not_found" };
      if (!target.active || target.name === "Client") return { status: "invalid_target" };
    }

    // Snapshot the referencing challenges (before-state for per-challenge audit diffs).
    const { rows: affected } = await client.query<{ id: string; client_name: string | null }>(
      `select id, client_name from challenges where impact_area_id = $1`,
      [id],
    );

    if (affected.length > 0) {
      if (!target) return { status: "has_references" };
      // Move every referencing challenge to the target and clear client_name (destination is
      // never Client). Admin maintenance, not an author edit: bump updated_at only — no edited_at,
      // no notification (§14.3).
      await client.query(
        `update challenges set impact_area_id = $2, client_name = null, updated_at = now() where impact_area_id = $1`,
        [id, target.id],
      );
      for (const ch of affected) {
        const before: Record<string, unknown> = { impactAreaId: id };
        const after: Record<string, unknown> = { impactAreaId: target.id };
        if (ch.client_name !== null) {
          before.clientName = ch.client_name;
          after.clientName = null;
        }
        await appendAudit(client, {
          actorUserId,
          action: "challenge.edited",
          targetType: "challenge",
          targetId: ch.id,
          before,
          after,
        });
      }
    }

    // Guarded delete: only removes the row if nothing references it any more (belt-and-braces
    // against a concurrent insert the retired-area rule should already prevent).
    const { rowCount } = await client.query(
      `delete from impact_areas where id = $1 and not exists (select 1 from challenges where impact_area_id = $1)`,
      [id],
    );
    if (!rowCount) return { status: "has_references" };

    await appendAudit(client, {
      actorUserId,
      action: "impact_area.deleted",
      targetType: "impact_area",
      targetId: id,
      before: { name: area.name, active: area.active },
      after: { reassignedTo: target?.id ?? null, reassignedToName: target?.name ?? null, reassignedCount: affected.length },
    });
    return { status: "ok" };
  });
}

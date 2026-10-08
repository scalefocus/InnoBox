// Data layer for the platform-admin audit browser (INNOBOX_SPEC.md §15): a read-only,
// filterable view over the append-only audit_log. Platform-admin-only (gated in the route).
// The log intentionally retains actor identity for provenance (§15), so this surface may show
// real names — it is the single authorized place to read the raw trail.
import type { Pool } from "pg";

export interface AuditFilters {
  action?: string;
  actorUserId?: string;
  targetType?: string;
  targetId?: string;
  from?: string; // ISO timestamp lower bound (inclusive)
  to?: string; // ISO timestamp upper bound (inclusive)
}

export interface AuditEntry {
  id: string;
  actorUserId: string | null;
  actorDisplayName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface AuditPage {
  rows: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export const AUDIT_PAGE_SIZE_DEFAULT = 50;
export const AUDIT_PAGE_SIZE_MAX = 100;

interface AuditQueryRow {
  id: string;
  actor_user_id: string | null;
  actor_display_name: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  before: unknown;
  after: unknown;
  created_at: Date;
  total_count: string;
}

export async function listAudit(pool: Pool, filters: AuditFilters, pagination: { page: number; pageSize: number }): Promise<AuditPage> {
  const params: unknown[] = [];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const conds: string[] = [];
  if (filters.action) conds.push(`a.action = ${push(filters.action)}`);
  if (filters.actorUserId) conds.push(`a.actor_user_id = ${push(filters.actorUserId)}`);
  if (filters.targetType) conds.push(`a.target_type = ${push(filters.targetType)}`);
  if (filters.targetId) conds.push(`a.target_id = ${push(filters.targetId)}`);
  if (filters.from) conds.push(`a.created_at >= ${push(filters.from)}`);
  if (filters.to) conds.push(`a.created_at <= ${push(filters.to)}`);
  const where = conds.length ? `where ${conds.join(" and ")}` : "";

  // page/pageSize are validated to integers by the caller before interpolation.
  const { page, pageSize } = pagination;
  const offset = (page - 1) * pageSize;

  const { rows } = await pool.query<AuditQueryRow>(
    `select a.id::text, a.actor_user_id, u.display_name as actor_display_name, a.action,
            a.target_type, a.target_id, a.before, a.after, a.created_at,
            count(*) over()::text as total_count
       from audit_log a
       left join users u on u.id = a.actor_user_id
       ${where}
       order by a.id desc
       limit ${pageSize} offset ${offset}`,
    params,
  );

  return {
    rows: rows.map((r) => ({
      id: r.id,
      actorUserId: r.actor_user_id,
      actorDisplayName: r.actor_display_name,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      before: r.before,
      after: r.after,
      createdAt: r.created_at.toISOString(),
    })),
    total: rows.length > 0 ? Number(rows[0]!.total_count) : 0,
    page,
    pageSize,
  };
}

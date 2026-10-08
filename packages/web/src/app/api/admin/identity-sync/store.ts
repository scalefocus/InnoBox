// Data layer for GET /api/admin/identity-sync (INNOBOX_SPEC.md §14.10): is Entra provisioning
// reaching InnoBox, and is it sending what roles need? Counts and group object ids only — no
// personal data, so the read is not audited. Authorization is the route's job; imports stay
// relative (not @/) so the gated dbtest can run under the plain node test runner.
import type { Pool } from "pg";
import {
  SCIM_LAST_REQUEST_AT_KEY,
  SYSTEM_LOG_RETENTION_DAYS,
  identitySyncState,
  type IdentitySyncState,
} from "@innobox/shared";
import type { Role } from "../validation";

/** The system-log route template the worker records SCIM 401/403s under (worker
 *  system-log/record.ts) — narrows the "last rejected" lookup so a webhook receiver's 401/403
 *  (also `source = worker`) can never pose as a rejected SCIM call. */
export const SCIM_SYSTEM_LOG_ROUTE = "/scim/v2/*";

export interface UnarrivedMappedGroup {
  groupExternalId: string;
  role: Role;
  /** null for a platform-scoped mapping. */
  namespaceId: string | null;
  namespaceName: string | null;
}

export interface IdentitySyncSummary {
  users: { active: number; deactivated: number };
  groups: number;
  unarrivedMappedGroups: UnarrivedMappedGroup[];
  lastScimRequestAt: string | null;
  lastRejectedScimRequestAt: string | null;
  state: IdentitySyncState;
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

export async function identitySyncSummary(db: Pool): Promise<IdentitySyncSummary> {
  const [users, groups, unarrived, lastRequest, lastRejected] = await Promise.all([
    // Provisioned users: SCIM-written rows only (JIT stubs and reconciliation-created rows are
    // scim_synced = false); scrubbed rows excluded (erasure clears the flag, but be explicit).
    db.query<{ active: number; deactivated: number }>(
      `select count(*) filter (where active)::int     as active,
              count(*) filter (where not active)::int as deactivated
         from users
        where scim_synced and scrubbed_at is null`,
    ),
    db.query<{ n: number }>(`select count(*)::int as n from groups where scim_synced`),
    // Mapped groups that never arrived: no groups row at all — the role-mapping card's "Dead" test.
    // One entry per distinct (group, role, namespace); the bootstrap admin group is not a mapping.
    db.query<{ group_external_id: string; role: Role; namespace_id: string | null; namespace_name: string | null }>(
      `select distinct rm.group_external_id, rm.role, rm.namespace_id, n.display_name as namespace_name
         from role_mappings rm
         left join namespaces n on n.id = rm.namespace_id
        where not exists (select 1 from groups g where g.external_id = rm.group_external_id)
        order by rm.group_external_id, rm.role, n.display_name nulls first`,
    ),
    db.query<{ value: unknown }>(`select value from platform_settings where key = $1`, [SCIM_LAST_REQUEST_AT_KEY]),
    db.query<{ at: Date | null }>(
      `select max(created_at) as at
         from system_events
        where source = 'worker'
          and status in (401, 403)
          and route = $1
          and created_at >= now() - make_interval(days => $2::int)`,
      [SCIM_SYSTEM_LOG_ROUTE, SYSTEM_LOG_RETENTION_DAYS],
    ),
  ]);

  const active = users.rows[0]?.active ?? 0;
  const deactivated = users.rows[0]?.deactivated ?? 0;
  const groupCount = groups.rows[0]?.n ?? 0;
  return {
    users: { active, deactivated },
    groups: groupCount,
    unarrivedMappedGroups: unarrived.rows.map((r) => ({
      groupExternalId: r.group_external_id,
      role: r.role,
      namespaceId: r.namespace_id,
      namespaceName: r.namespace_name,
    })),
    lastScimRequestAt: isoOrNull(lastRequest.rows[0]?.value),
    lastRejectedScimRequestAt: isoOrNull(lastRejected.rows[0]?.at),
    state: identitySyncState({ users: active + deactivated, groups: groupCount }),
  };
}

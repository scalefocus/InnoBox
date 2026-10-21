// Role resolution in ONE statement (INNOBOX_SPEC.md §4.2 *Resolution*, ENTRA_AUTH_SPEC.md "Role
// staleness"). Roles come from SCIM-synced group membership + role_mappings on every request, never
// from token claims (invariant 1), and nothing here is cached across requests. What this module
// bounds is the cost: the grants, the bootstrap-group implicit mapping, the §4.3 `people` access
// list and the built-in `global` namespace id are read in a single round trip — as arrays on one
// row per user — where they used to be three or four sequential queries.
//
// Kept free of next/* and next-auth so the gated `.dbtest.ts` suites can run it under the plain
// node test runner; lib/auth.ts is the session-facing wrapper.
import type { Pool, PoolClient } from "pg";
import { buildRoleSet, type Role, type RoleGrant, type RoleSet } from "@innobox/shared";

type Db = Pool | PoolClient;

/** The per-user role columns, correlated on `uid` (a uuid expression in the enclosing query).
 *  `$bootstrap` is the parameter holding INNOBOX_BOOTSTRAP_ADMIN_GROUP (null when unset). The
 *  global namespace is an uncorrelated scalar subquery — Postgres evaluates it once per statement. */
function roleColumns(uid: string, bootstrap: string): string {
  return `
    coalesce((
      select json_agg(json_build_object('role', rm.role, 'namespace_id', rm.namespace_id))
        from group_members gm
        join groups g         on g.id = gm.group_id
        join role_mappings rm on rm.group_external_id = g.external_id
       where gm.user_id = ${uid}
    ), '[]'::json) as grants,
    (${bootstrap}::text is not null and exists (
      select 1 from group_members gm
        join groups g on g.id = gm.group_id
       where gm.user_id = ${uid} and g.external_id = ${bootstrap}::text
    )) as bootstrap_admin,
    coalesce((
      select array_agg(ca.challenge_id::text order by ca.challenge_id) from challenge_access ca where ca.user_id = ${uid}
    ), '{}'::text[]) as access,
    (select ns.id from namespaces ns where ns.slug = 'global') as global_namespace_id`;
}

interface RoleRow {
  grants: { role: Role; namespace_id: string | null }[];
  bootstrap_admin: boolean;
  access: string[];
  global_namespace_id: string | null;
}

function toRoleSet(row: RoleRow): RoleSet {
  if (!row.global_namespace_id) throw new Error("built-in 'global' namespace missing — are migrations applied?");
  const grants: RoleGrant[] = row.grants.map((g) => ({ role: g.role, namespaceId: g.namespace_id }));
  return buildRoleSet(grants, {
    bootstrapPlatformAdmin: row.bootstrap_admin,
    globalNamespaceId: row.global_namespace_id,
    accessListChallengeIds: row.access,
  });
}

/** Resolves a RoleSet for each of many user ids in ONE statement, whatever the count — notification
 *  dispatch visibility-checks every candidate recipient of an event at once. Every id gets an entry
 *  (driven by the id list, not the users table); a user with no grants gets the implicit-member
 *  RoleSet. */
export async function resolveRoleSets(db: Db, userIds: readonly string[], bootstrapGroup: string | null): Promise<Map<string, RoleSet>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const { rows } = await db.query<RoleRow & { user_id: string }>(
    `select ids.id::text as user_id, ${roleColumns("ids.id", "$2")}
       from unnest($1::uuid[]) as ids(id)`,
    [ids, bootstrapGroup],
  );
  return new Map(rows.map((r) => [r.user_id, toRoleSet(r)]));
}

/** The session-facing user row, before the active / revocation checks lib/auth.ts applies. */
export interface SessionRow {
  id: string;
  externalId: string;
  userName: string;
  email: string | null;
  displayName: string;
  active: boolean;
  sessionsValidFrom: Date | null;
  emailNotificationsEnabled: boolean;
  quickStartSeenAt: Date | null;
  whatsNewSeenVersion: string | null;
  whatsNewSinceDate: string | null;
  roles: RoleSet;
}

/** The user row by Entra `oid` AND its roles, in one statement (§4.2). Null when no row exists. */
export async function loadSessionRow(db: Db, oid: string, bootstrapGroup: string | null): Promise<SessionRow | null> {
  const { rows } = await db.query<
    RoleRow & {
      id: string;
      external_id: string;
      user_name: string;
      email: string | null;
      display_name: string;
      active: boolean;
      sessions_valid_from: Date | null;
      email_notifications_enabled: boolean;
      quick_start_seen_at: Date | null;
      whats_new_seen_version: string | null;
      whats_new_since_date: string | null;
    }
  >(
    // The rollout boundary is a bare calendar date: read it as text, never through a JS Date,
    // which would shift it by the server's offset.
    `select u.id, u.external_id, u.user_name, u.email, u.display_name, u.active, u.sessions_valid_from,
            u.email_notifications_enabled, u.quick_start_seen_at, u.whats_new_seen_version,
            to_char(u.whats_new_since_date, 'YYYY-MM-DD') as whats_new_since_date,
            ${roleColumns("u.id", "$2")}
       from users u
      where u.external_id = $1`,
    [oid, bootstrapGroup],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    externalId: row.external_id,
    userName: row.user_name,
    email: row.email,
    displayName: row.display_name,
    active: row.active,
    sessionsValidFrom: row.sessions_valid_from,
    emailNotificationsEnabled: row.email_notifications_enabled,
    quickStartSeenAt: row.quick_start_seen_at,
    whatsNewSeenVersion: row.whats_new_seen_version,
    whatsNewSinceDate: row.whats_new_since_date,
    roles: toRoleSet(row),
  };
}

/** INNOBOX_BOOTSTRAP_ADMIN_GROUP, or null when unset/blank — read per call, like before. */
export function bootstrapAdminGroup(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.INNOBOX_BOOTSTRAP_ADMIN_GROUP;
  return v ? v : null;
}

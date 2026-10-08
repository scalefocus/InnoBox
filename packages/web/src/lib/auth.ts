// Per-request session validation + role resolution (ENTRA_AUTH_SPEC.md §5). The JWT
// cookie only proves authentication happened; identity, `active`, and roles come from
// the database on EVERY request — a deactivated user holding a live cookie loses access
// at the next call (§2 leaver semantics), and roles NEVER come from token claims
// (INNOBOX_SPEC.md invariant 1; per-request resolution, no role cache in v1).
import { headers } from "next/headers";
import { getServerSession } from "next-auth";
import { buildRoleSet, type Role, type RoleGrant, type RoleSet } from "@innobox/shared";
import { authOptions } from "./authOptions";
import { pool } from "./db";
import { PRESENCE_METHOD_HEADER, PRESENCE_PATH_HEADER, touchPresence } from "./presence-touch";

export interface SessionUser {
  id: string;
  externalId: string;
  userName: string;
  displayName: string;
  email: string | null;
  emailNotificationsEnabled: boolean;
  quickStartSeenAt: Date | null;
  roles: RoleSet;
}

// The built-in 'global' namespace is seeded by migration 0003 and can never be deleted
// (namespaces are archive-only), so its id is safe to cache for the process lifetime.
let globalNamespaceId: string | null = null;
async function getGlobalNamespaceId(): Promise<string> {
  if (!globalNamespaceId) {
    const { rows } = await pool.query<{ id: string }>(
      `select id from namespaces where slug = 'global'`,
    );
    if (!rows[0]) throw new Error("built-in 'global' namespace missing — are migrations applied?");
    globalNamespaceId = rows[0].id;
  }
  return globalNamespaceId;
}

/** Resolves a RoleSet for an arbitrary user id (not just the session user) — used by
 *  notification dispatch (lib/notify.ts) to visibility-check candidate recipients. Same
 *  join + bootstrap logic getSessionUser uses for itself. */
export async function resolveRolesForUser(userId: string): Promise<RoleSet> {
  const { rows: grantRows } = await pool.query<{ role: Role; namespace_id: string | null }>(
    `select rm.role, rm.namespace_id
       from group_members gm
       join groups g         on g.id = gm.group_id
       join role_mappings rm on rm.group_external_id = g.external_id
      where gm.user_id = $1`,
    [userId],
  );
  const grants: RoleGrant[] = grantRows.map((g) => ({ role: g.role, namespaceId: g.namespace_id }));

  let bootstrapPlatformAdmin = false;
  const bootstrapGroup = process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP;
  if (bootstrapGroup) {
    const { rows: b } = await pool.query(
      `select 1
         from group_members gm
         join groups g on g.id = gm.group_id
        where gm.user_id = $1 and g.external_id = $2`,
      [userId, bootstrapGroup],
    );
    bootstrapPlatformAdmin = b.length > 0;
  }

  return buildRoleSet(grants, { bootstrapPlatformAdmin, globalNamespaceId: await getGlobalNamespaceId() });
}

/** Presence stamp (§14.5), on the only per-request node-layer hook there is. The pathname
 *  arrives as a middleware-injected header because Next hands route handlers no matched
 *  path; `headers()` throws outside a request scope, and the whole thing is best-effort —
 *  presence must never be able to fail the request it rides on. */
async function stampPresence(userId: string): Promise<void> {
  try {
    const h = await headers();
    touchPresence(pool, userId, h.get(PRESENCE_PATH_HEADER), h.get(PRESENCE_METHOD_HEADER));
  } catch {
    /* no request scope (build-time page collection, tests) — nothing to record */
  }
}

/** The signed-in, ACTIVE user with DB-resolved roles — or null (unauthenticated, or the
 *  user row is missing/deactivated: same outcome, no session). */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  const oid = session?.oid;
  if (!oid) return null;

  const { rows } = await pool.query<{
    id: string;
    external_id: string;
    user_name: string;
    email: string | null;
    display_name: string;
    active: boolean;
    email_notifications_enabled: boolean;
    quick_start_seen_at: Date | null;
  }>(
    `select id, external_id, user_name, email, display_name, active, email_notifications_enabled, quick_start_seen_at
       from users
      where external_id = $1`,
    [oid],
  );
  const row = rows[0];
  if (!row || !row.active) return null;

  await stampPresence(row.id);

  const roles = await resolveRolesForUser(row.id);

  return {
    id: row.id,
    externalId: row.external_id,
    userName: row.user_name,
    displayName: row.display_name,
    email: row.email,
    emailNotificationsEnabled: row.email_notifications_enabled,
    quickStartSeenAt: row.quick_start_seen_at,
    roles,
  };
}

export type Guard = { ok: true; user: SessionUser } | { ok: false; response: Response };

/** For API routes: 401 JSON when there is no valid, active session. */
export async function requireUser(): Promise<Guard> {
  const user = await getSessionUser();
  if (!user) {
    return { ok: false, response: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  }
  return { ok: true, user };
}

/** For platform-admin API routes: 401 without a session, 403 without the role. */
export async function requirePlatformAdmin(): Promise<Guard> {
  const guard = await requireUser();
  if (!guard.ok) return guard;
  if (!guard.user.roles.isPlatformAdmin) {
    return { ok: false, response: Response.json({ error: "forbidden" }, { status: 403 }) };
  }
  return guard;
}

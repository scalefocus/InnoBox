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
import { isSessionRevoked } from "./session-revocation";

export interface SessionUser {
  id: string;
  externalId: string;
  userName: string;
  displayName: string;
  email: string | null;
  emailNotificationsEnabled: boolean;
  quickStartSeenAt: Date | null;
  /** §13.9 What's new marker, raw as stored (the rules treat a non-x.y.z value as null). */
  whatsNewSeenVersion: string | null;
  /** §13.9 one-time rollout boundary, `YYYY-MM-DD` — read only while the marker is null. */
  whatsNewSinceDate: string | null;
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

/** Resolves a RoleSet for each of many user ids in a fixed number of queries, whatever the count —
 *  notification dispatch (lib/notify.ts) visibility-checks every candidate recipient of an event,
 *  and a per-user lookup made that cost grow with the recipient list. Every id gets an entry; a
 *  user with no grants gets the implicit-member RoleSet. The ONE place roles are resolved
 *  (invariant 1): resolveRolesForUser and getSessionUser go through it too. */
export async function resolveRolesForUsers(userIds: readonly string[]): Promise<Map<string, RoleSet>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();

  const grants = new Map<string, RoleGrant[]>(ids.map((id) => [id, []]));
  const { rows: grantRows } = await pool.query<{ user_id: string; role: Role; namespace_id: string | null }>(
    `select gm.user_id, rm.role, rm.namespace_id
       from group_members gm
       join groups g         on g.id = gm.group_id
       join role_mappings rm on rm.group_external_id = g.external_id
      where gm.user_id = any($1::uuid[])`,
    [ids],
  );
  for (const g of grantRows) grants.get(g.user_id)!.push({ role: g.role, namespaceId: g.namespace_id });

  const bootstrapAdmins = new Set<string>();
  const bootstrapGroup = process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP;
  if (bootstrapGroup) {
    const { rows: b } = await pool.query<{ user_id: string }>(
      `select distinct gm.user_id
         from group_members gm
         join groups g on g.id = gm.group_id
        where gm.user_id = any($1::uuid[]) and g.external_id = $2`,
      [ids, bootstrapGroup],
    );
    for (const r of b) bootstrapAdmins.add(r.user_id);
  }

  // §4.3 `people`: the challenges whose access list names the user — resolved per request with the
  // grants, so the visibility gate and its SQL twin read it exactly like namespace membership.
  const access = new Map<string, string[]>(ids.map((id) => [id, []]));
  const { rows: accessRows } = await pool.query<{ user_id: string; challenge_id: string }>(
    `select user_id, challenge_id from challenge_access where user_id = any($1::uuid[])`,
    [ids],
  );
  for (const r of accessRows) access.get(r.user_id)!.push(r.challenge_id);

  const globalNamespaceId = await getGlobalNamespaceId();
  return new Map(
    ids.map((id) => [
      id,
      buildRoleSet(grants.get(id)!, {
        bootstrapPlatformAdmin: bootstrapAdmins.has(id),
        globalNamespaceId,
        accessListChallengeIds: access.get(id)!,
      }),
    ]),
  );
}

/** Resolves a RoleSet for an arbitrary user id (not just the session user) — the assignee and
 *  successor checks, and the shape every NotifyContext is built with. It carries the bulk resolver
 *  as `.many`, so a notification fan-out given this function resolves all its recipients at once
 *  (lib/notify.ts finalRecipients) without any caller changing. */
export const resolveRolesForUser = Object.assign(
  async (userId: string): Promise<RoleSet> => (await resolveRolesForUsers([userId])).get(userId)!,
  { many: resolveRolesForUsers },
);

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
 *  user row is missing/deactivated, or the token was issued before the row's
 *  `sessions_valid_from` — "Sign out everywhere", INNOBOX_SPEC.md §3: same outcome, no session). */
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
    sessions_valid_from: Date | null;
    email_notifications_enabled: boolean;
    quick_start_seen_at: Date | null;
    whats_new_seen_version: string | null;
    whats_new_since_date: string | null;
  }>(
    // The rollout boundary is a bare calendar date: read it as text, never through a JS Date,
    // which would shift it by the server's offset.
    `select id, external_id, user_name, email, display_name, active, sessions_valid_from, email_notifications_enabled, quick_start_seen_at,
            whats_new_seen_version, to_char(whats_new_since_date, 'YYYY-MM-DD') as whats_new_since_date
       from users
      where external_id = $1`,
    [oid],
  );
  const row = rows[0];
  if (!row || !row.active) return null;
  // §3 Sign out everywhere / erasure / SCIM deactivation stamp: a token minted before it is no
  // session, whatever the cookie says — the API answers 401, a page redirects to Home.
  if (isSessionRevoked({ issuedAt: session.issuedAt, sessionsValidFrom: row.sessions_valid_from })) return null;

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
    whatsNewSeenVersion: row.whats_new_seen_version,
    whatsNewSinceDate: row.whats_new_since_date,
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

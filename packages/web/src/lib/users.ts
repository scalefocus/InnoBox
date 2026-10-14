// User lookup + JIT provisioning from OIDC claims (ENTRA_AUTH_SPEC.md §5, layer 1).
// The identity key is the Entra object id (users.external_id == token `oid` == SCIM
// externalId) — never email/UPN, which are mutable and reassignable. Attribute ownership:
// a JIT stub (scim_synced=false) is refreshed from claims at each sign-in; once SCIM or
// reconciliation set scim_synced=true, claims never overwrite.
import type { Pool } from "pg";
import { bindPendingAccess } from "@innobox/shared";
import { APP_VERSION } from "@innobox/shared/version";
import { appendAudit } from "./audit";
import { isCalendarDate, isVersion } from "./whats-new";
import { setSurveyForcedWin } from "./survey-dev";

export interface UserRow {
  id: string;
  externalId: string;
  userName: string;
  email: string | null;
  displayName: string;
  active: boolean;
  scimSynced: boolean;
  emailNotificationsEnabled: boolean;
  quickStartSeenAt: Date | null;
}

interface DbUserRecord {
  id: string;
  external_id: string;
  user_name: string;
  email: string | null;
  display_name: string;
  active: boolean;
  scim_synced: boolean;
  email_notifications_enabled: boolean;
  quick_start_seen_at: Date | null;
}

const USER_COLUMNS =
  "id, external_id, user_name, email, display_name, active, scim_synced, email_notifications_enabled, quick_start_seen_at";

function mapUserRow(r: DbUserRecord): UserRow {
  return {
    id: r.id,
    externalId: r.external_id,
    userName: r.user_name,
    email: r.email,
    displayName: r.display_name,
    active: r.active,
    scimSynced: r.scim_synced,
    emailNotificationsEnabled: r.email_notifications_enabled,
    quickStartSeenAt: r.quick_start_seen_at,
  };
}

export async function getUserByExternalId(db: Pool, externalId: string): Promise<UserRow | null> {
  const { rows } = await db.query<DbUserRecord>(
    `select ${USER_COLUMNS} from users where external_id = $1`,
    [externalId],
  );
  return rows[0] ? mapUserRow(rows[0]) : null;
}

// ── JIT decision (pure — unit-tested in users.test.ts) ─────────────────────────────────────

export interface JitClaims {
  oid: string;
  userName: string;
  email: string | null;
  displayName: string;
}

/** What the decision needs to know about the stored row (UserRow satisfies it). */
export interface JitSnapshot {
  userName: string;
  email: string | null;
  displayName: string;
  active: boolean;
  scimSynced: boolean;
}

/** Keys are the exact users columns a sign-in may touch — nothing else, ever. */
export type JitPatch = Partial<{ user_name: string; email: string | null; display_name: string }>;

export type JitDecision =
  | { action: "insert" }
  | { action: "refresh"; patch: JitPatch }
  | { action: "none" };

export function decideJitAction(existing: JitSnapshot | null, claims: JitClaims): JitDecision {
  if (!existing) return { action: "insert" };
  // SCIM/reconciliation own attributes once synced; deactivated rows are never touched
  // from sign-in claims either (the signIn callback rejects those sessions upstream).
  if (existing.scimSynced || !existing.active) return { action: "none" };
  const patch: JitPatch = {};
  if (claims.userName !== existing.userName) patch.user_name = claims.userName;
  if (claims.email !== existing.email) patch.email = claims.email;
  if (claims.displayName !== existing.displayName) patch.display_name = claims.displayName;
  return Object.keys(patch).length === 0 ? { action: "none" } : { action: "refresh", patch };
}

/** First sign-in inserts a stub (audited `user.jit_created`); later sign-ins refresh the
 *  stub's mutable attributes; synced rows pass through untouched. Returns the resulting row.
 *  `skipQuickStart` marks the new row as having already seen /quick-start at creation —
 *  used only by the dev/e2e fixture path (upsertDevUser) so synthetic test personas aren't
 *  interrupted by onboarding; real Entra JIT sign-ins never pass it, leaving genuinely new
 *  users unseen (INNOBOX_SPEC.md §13.7). */
export async function jitUpsertFromClaims(
  db: Pool,
  claims: JitClaims,
  opts?: { skipQuickStart?: boolean },
): Promise<UserRow> {
  const existing = await getUserByExternalId(db, claims.oid);
  const decision = decideJitAction(existing, claims);
  if (!existing || decision.action === "insert") {
    const { rows } = await db.query<DbUserRecord>(
      `insert into users (external_id, user_name, email, display_name, scim_synced, quick_start_seen_at)
       values ($1, $2, $3, $4, false, case when $5 then now() else null end)
       on conflict (external_id) do nothing
       returning ${USER_COLUMNS}`,
      [claims.oid, claims.userName, claims.email, claims.displayName, Boolean(opts?.skipQuickStart)],
    );
    if (!rows[0]) {
      // Lost a concurrent first-sign-in race: the other request inserted (and audited) it.
      const raced = await getUserByExternalId(db, claims.oid);
      if (!raced) throw new Error("users upsert conflicted without a row");
      return raced;
    }
    const user = mapUserRow(rows[0]);
    await appendAudit(db, {
      actorUserId: user.id,
      action: "user.jit_created",
      targetType: "user",
      targetId: user.id,
      after: { externalId: user.externalId, userName: user.userName, displayName: user.displayName },
    });
    // §4.3: a pending access-list entry for this address now names a user.
    await bindPendingAccess(db, user.id);
    return user;
  }
  if (decision.action === "refresh") {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of Object.entries(decision.patch)) {
      params.push(value);
      sets.push(`${column} = $${params.length}`); // columns come from the fixed JitPatch key set
    }
    params.push(existing.id);
    await db.query(
      `update users set ${sets.join(", ")}, updated_at = now() where id = $${params.length}`,
      params,
    );
    if (decision.patch.email !== undefined || decision.patch.user_name !== undefined) await bindPendingAccess(db, existing.id);
    return {
      ...existing,
      userName: decision.patch.user_name ?? existing.userName,
      email: decision.patch.email !== undefined ? decision.patch.email : existing.email,
      displayName: decision.patch.display_name ?? existing.displayName,
    };
  }
  return existing;
}

// ── Dev bypass fixtures (INNOBOX_DEV_AUTH — never registered in production builds) ─────────

export interface DevUserInput {
  name: string;
  email: string | null;
  admin: boolean;
  /** When true, a newly created dev persona is left unseen for /quick-start (INNOBOX_SPEC.md
   *  §13.7) so its e2e test can exercise the real first-sign-in redirect. Defaults to marking
   *  the persona as already seen, so ordinary dev/e2e sign-ins aren't interrupted by onboarding. */
  freshOnboarding?: boolean;
  /** §13.10: true → the persona is survey-eligible right now (surveys on, Quick start 15 days ago,
   *  no survey history or first uses) and its rolls are forced to win (lib/survey-dev.ts). False
   *  (the default) → surveys off, so ordinary dev/e2e sessions never see the card. */
  survey?: boolean;
  /** §13.9 seam. Blank (the default) stamps the What's new marker at APP_VERSION, so ordinary
   *  dev/e2e sessions are never interrupted by the update notice. A strict x.y.z seeds that
   *  marker; `none` leaves it null so the rollout boundary below applies. */
  whatsNewSeen?: string;
  /** With `whatsNewSeen: "none"`: the rollout boundary date (YYYY-MM-DD) to seed, else none. */
  whatsNewSinceDate?: string;
}

/** The (marker, rollout date) pair a dev sign-in writes — pure, unit-tested. */
export function devWhatsNewSeed(input: Pick<DevUserInput, "whatsNewSeen" | "whatsNewSinceDate">): {
  seen: string | null;
  sinceDate: string | null;
} {
  const raw = input.whatsNewSeen?.trim() ?? "";
  if (raw.toLowerCase() === "none") {
    const date = input.whatsNewSinceDate?.trim();
    return { seen: null, sinceDate: isCalendarDate(date) ? date : null };
  }
  return { seen: isVersion(raw) ? raw : APP_VERSION, sinceDate: null };
}

const DEV_ADMIN_GROUP = { externalId: "dev-platform-admins", displayName: "Dev Platform Admins" };

export function devSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "user"
  );
}

/** Materializes a real local user for the dev Credentials provider — and, when `admin`,
 *  the dev group + `platform_admin` role mapping + membership — so RBAC still resolves
 *  from the database exactly as in production; the session never carries roles. The dev
 *  plumbing rows are local fixtures, not audited admin actions (`user.jit_created` aside). */
export async function upsertDevUser(db: Pool, input: DevUserInput): Promise<UserRow> {
  const slug = devSlug(input.name);
  const user = await jitUpsertFromClaims(
    db,
    {
      oid: `dev-${slug}`,
      // user_name must stay 1:1 with the synthetic identity (external_id = `dev-${slug}`).
      // Deriving it from the mutable email let two dev personas that share an email — e.g.
      // signing in as "Dev" then "Krasi Admin", both with dev@innobox.innovate — collide on
      // lower(user_name) while getting DIFFERENT external_ids. The JIT INSERT's
      // `on conflict (external_id) do nothing` can't catch that, so the second sign-in 500s
      // on the users_user_name_lower_idx unique index. The email still lands in the email column.
      userName: `${slug}@dev.test`,
      email: input.email,
      displayName: input.name,
    },
    { skipQuickStart: !input.freshOnboarding },
  );
  // §13.9: every dev sign-in sets the What's new marker — APP_VERSION unless a spec seeds one.
  const seed = devWhatsNewSeed(input);
  await db.query(`update users set whats_new_seen_version = $2, whats_new_since_date = $3::date where id = $1`, [
    user.id,
    seed.seen,
    seed.sinceDate,
  ]);
  await prepareDevSurveyState(db, user.id, Boolean(input.survey));
  if (input.admin) {
    const { rows } = await db.query<{ id: string }>(
      `insert into groups (external_id, display_name)
       values ($1, $2)
       on conflict (external_id) do update set display_name = excluded.display_name, updated_at = now()
       returning id`,
      [DEV_ADMIN_GROUP.externalId, DEV_ADMIN_GROUP.displayName],
    );
    const groupId = rows[0]?.id;
    if (!groupId) throw new Error("dev group upsert returned no row");
    // UNIQUE (group_external_id, role, namespace_id) can't catch duplicates when
    // namespace_id is NULL (platform_admin rows), hence WHERE NOT EXISTS over ON CONFLICT.
    await db.query(
      `insert into role_mappings (group_external_id, role, namespace_id)
       select $1, 'platform_admin', null
        where not exists (
          select 1 from role_mappings
           where group_external_id = $1 and role = 'platform_admin' and namespace_id is null)`,
      [DEV_ADMIN_GROUP.externalId],
    );
    await db.query(
      `insert into group_members (group_id, user_id) values ($1, $2) on conflict do nothing`,
      [groupId, user.id],
    );
  } else {
    // Signing in without the admin flag drops it, so the toggle round-trips in dev/e2e.
    await db.query(
      `delete from group_members
        where user_id = $1
          and group_id in (select id from groups where external_id = $2)`,
      [user.id, DEV_ADMIN_GROUP.externalId],
    );
  }
  return user;
}

/** The dev sign-in's survey switch (INNOBOX_SPEC.md §13.10). Every dev sign-in resets the persona's
 *  survey state: off by default; with `survey`, eligible at once and with the roll forced to win. */
async function prepareDevSurveyState(db: Pool, userId: string, survey: boolean): Promise<void> {
  if (survey) {
    await db.query(
      `update users
          set surveys_enabled = true,
              quick_start_seen_at = now() - interval '15 days',
              survey_last_shown_at = null, survey_offer = null, survey_self_shown_at = null
        where id = $1`,
      [userId],
    );
    await db.query(`delete from user_feature_uses where user_id = $1`, [userId]);
  } else {
    await db.query(`update users set surveys_enabled = false, survey_offer = null where id = $1`, [userId]);
  }
  setSurveyForcedWin(userId, survey);
}

// Data layer for /api/users (INNOBOX_SPEC.md §7.3): the searchable active-user directory
// backing the namespace admin's assignment picker. Not admin-gated at this layer — any
// authenticated user may search (enforced in route.ts); this module only returns the
// minimal id/displayName/email projection, never roles or namespace membership.
import type { Pool, PoolClient } from "pg";
import { eraseUserGrants, escapeLike, type ChallengeVisibilityInput } from "@innobox/shared";
import { appendAudit } from "../../../lib/audit";
import { inTransaction } from "../../../lib/db";
import { getPlatformAdminUserIds } from "../../../lib/notify";
import { scrubSystemEventsForUser } from "../admin/system-log/store";
import { handOverOpenAssignments, isEligibleSuccessor, type ReassignmentResult, type SuccessorHandover } from "./erasure-reassignment";

export interface UserSearchResult {
  id: string;
  displayName: string;
  email: string | null;
}

const RESULT_LIMIT = 10;

/**
 * §7.3: the SQL condition "user `u` can see this challenge" — canSeeChallenge evaluated for every
 * candidate at once, with roles resolved the way resolveRolesForUser resolves them (SCIM-synced
 * group membership joined through role_mappings, plus the bootstrap admin group; invariant 1).
 * In SQL so the picker's limit applies to assignable users only. Pinned to the JS predicate by
 * store.dbtest.ts.
 */
function canSeeChallengeCondition(audience: ChallengeVisibilityInput, push: (v: unknown) => string): string {
  const stateRule = audience.status === "awaiting_triage" || audience.status === "withdrawn";
  // Org-visible and past triage: every active user can see it. Return before pushing anything —
  // an unreferenced parameter has no type and Postgres refuses the query. A `people` challenge past
  // triage relaxes the gate instead (§7.3): assigning someone puts them on its access list, so the
  // picker offers every active user.
  if (!stateRule && (audience.visibility === "org" || audience.visibility === "people")) return "true";

  const grant = (namespaceCondition: string) =>
    `exists (select 1 from group_members gm
               join groups g on g.id = gm.group_id
               join role_mappings rm on rm.group_external_id = g.external_id
              where gm.user_id = u.id and (rm.role = 'platform_admin' or ${namespaceCondition}))`;
  const bootstrapGroup = process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP;
  const bootstrap = bootstrapGroup
    ? ` or exists (select 1 from group_members gm join groups g on g.id = gm.group_id
                    where gm.user_id = u.id and g.external_id = ${push(bootstrapGroup)})`
    : "";
  const namespace = push(audience.namespaceId);

  if (stateRule) {
    // §39.6: every member of the team sees it; a public-form challenge (§24.6) has none.
    return `(u.id = any(${push([...audience.authorIds])}::uuid[]) or ${grant(`(rm.role = 'namespace_admin' and rm.namespace_id = ${namespace})`)}${bootstrap})`;
  }
  // Namespace-visible: members of the namespace — and every active user is an implicit member
  // of the built-in global namespace (§4.1).
  return `(${namespace} = (select id from namespaces where slug = 'global')
           or ${grant(`rm.namespace_id = ${namespace}`)}${bootstrap})`;
}

/** The roles join the co-author conditions share: user `u` holds a grant matching `namespaceCondition`,
 *  or is a platform admin, or is in the bootstrap admin group (invariant 1). */
function grantCondition(namespaceCondition: string, push: (v: unknown) => string): string {
  const bootstrapGroup = process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP;
  const bootstrap = bootstrapGroup
    ? ` or exists (select 1 from group_members gm join groups g on g.id = gm.group_id
                    where gm.user_id = u.id and g.external_id = ${push(bootstrapGroup)})`
    : "";
  return `(exists (select 1 from group_members gm
                     join groups g on g.id = gm.group_id
                     join role_mappings rm on rm.group_external_id = g.external_id
                    where gm.user_id = u.id and (rm.role = 'platform_admin' or ${namespaceCondition}))${bootstrap})`;
}

/**
 * §39.2: the SQL twin of `canJoinChallengeTeam` (`full: false`) and of `canSeeChallenge` (`full: true`,
 * the solution form and a solution's team: the people who can see its parent) for every candidate at
 * once. Unlike the §7.3 assignee condition it never relaxes for a `people` challenge — a member never
 * widens visibility. Pinned to the JS predicates by store.dbtest.ts.
 */
function canJoinCondition(challenge: ChallengeVisibilityInput, full: boolean, push: (v: unknown) => string): string {
  const namespace = () => push(challenge.namespaceId);
  let rule: string;
  if (challenge.visibility === "org") rule = "true";
  else if (challenge.visibility === "namespace") {
    const ns = namespace();
    rule = `(${ns} = (select id from namespaces where slug = 'global') or ${grantCondition(`rm.namespace_id = ${ns}`, push)})`;
  } else {
    const ns = namespace();
    rule = `(${grantCondition(`(rm.role in ('namespace_admin', 'committee') and rm.namespace_id = ${ns})`, push)}
             or u.id = ${push(challenge.assigneeId)}::uuid
             or exists (select 1 from challenge_access cax where cax.challenge_id = ${push(challenge.id)} and cax.user_id = u.id))`;
  }
  if (!full || (challenge.status !== "awaiting_triage" && challenge.status !== "withdrawn")) return rule;
  return `(u.id = any(${push([...challenge.authorIds])}::uuid[]) or ${grantCondition(`(rm.role = 'namespace_admin' and rm.namespace_id = ${namespace()})`, push)})`;
}

/** Who a co-author picker searches (§39.2): the people who can join this challenge's team, or —
 *  `full` — who can see this challenge under the whole §4.3 predicate (a solution's team). `exclude`
 *  are the item's current members and everyone who left it (§39.4); the caller is always left out. */
export interface CoAuthorAudience {
  challenge: ChallengeVisibilityInput;
  full: boolean;
  exclude: readonly string[];
  callerId: string;
}

/** The directory search. With `audience`, only users who can see that challenge (§7.3); with
 *  `coAuthors`, only the people who can be added to that team (§39.2). The query is a literal
 *  substring (§2.4): `%`, `_` and `\` match themselves, so `q=%` matches nobody. */
export async function searchActiveUsers(pool: Pool, query: string, audience?: ChallengeVisibilityInput, coAuthors?: CoAuthorAudience): Promise<UserSearchResult[]> {
  const params: unknown[] = [`%${escapeLike(query)}%`];
  const push = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const conditions = [audience ? canSeeChallengeCondition(audience, push) : "true"];
  if (coAuthors) {
    conditions.push(canJoinCondition(coAuthors.challenge, coAuthors.full, push));
    conditions.push(`u.scrubbed_at is null`, `u.id <> all(${push([coAuthors.callerId, ...coAuthors.exclude])}::uuid[])`);
  }
  const { rows } = await pool.query<{ id: string; display_name: string; email: string | null }>(
    `select u.id, u.display_name, u.email from users u
      where u.active = true and (u.display_name ilike $1 or u.email ilike $1) and ${conditions.join(" and ")}
      order by u.display_name limit ${RESULT_LIMIT}`,
    params,
  );
  return rows.map((r) => ({ id: r.id, displayName: r.display_name, email: r.email }));
}

export interface AdminUserResult {
  id: string;
  displayName: string;
  email: string | null;
  active: boolean;
  scrubbed: boolean;
}

/** Admin-only directory search (platform-admin, gated in the route): unlike searchActiveUsers
 *  this includes INACTIVE users — GDPR erasure primarily targets leavers (deactivated) — and
 *  surfaces whether a user has already been scrubbed. */
export async function searchUsersForAdmin(pool: Pool, query: string): Promise<AdminUserResult[]> {
  const { rows } = await pool.query<{ id: string; display_name: string; email: string | null; active: boolean; scrubbed_at: Date | null }>(
    `select id, display_name, email, active, scrubbed_at from users
      where display_name ilike $1 or email ilike $1
      order by active desc, display_name limit ${RESULT_LIMIT}`,
    [`%${escapeLike(query)}%`], // §2.4: literal substring, same as searchActiveUsers
  );
  return rows.map((r) => ({ id: r.id, displayName: r.display_name, email: r.email, active: r.active, scrubbed: r.scrubbed_at !== null }));
}

/** What `GET /api/users/:id/card` returns — the directory hover card's payload (§13.8).
 *  Deliberately narrow: no e-mail (the public profile withholds it too, §13.5), no presence, no
 *  roles, no contribution counts — a card that carried per-namespace roles or per-viewer counts
 *  would leak restricted items through a surface every viewer sees identically (invariant 2). */
export interface UserCard {
  userId: string;
  displayName: string;
  jobTitle: string | null;
  officeLocation: string | null;
  department: string | null;
  /** SCIM-deactivated — the bubble is already greyed (§13.6), so the card names the state. */
  deactivated: boolean;
  /** GDPR-erased tombstone: always renders "No directory information", never a profile link. */
  scrubbed: boolean;
}

/** The hover card's data for one user (§13.8). Any authenticated user may read any user's card —
 *  InnoBox has no per-user visibility model (invariant 2 governs challenges) and
 *  `/api/profile/:userId` already exposes the same three fields to any signed-in caller.
 *  Returns null for an unknown id → 404. A scrubbed row's directory fields are already NULL in the
 *  database (§3 erasure); they are re-nulled here as belt and braces. */
export async function getUserCard(pool: Pool, userId: string): Promise<UserCard | null> {
  const { rows } = await pool.query<{
    id: string;
    display_name: string;
    job_title: string | null;
    office_location: string | null;
    department: string | null;
    active: boolean;
    scrubbed_at: Date | null;
  }>(
    `select id, display_name, job_title, office_location, department, active, scrubbed_at
       from users where id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;

  const scrubbed = row.scrubbed_at !== null;
  return {
    userId: row.id,
    displayName: row.display_name,
    jobTitle: scrubbed ? null : row.job_title,
    officeLocation: scrubbed ? null : row.office_location,
    department: scrubbed ? null : row.department,
    deactivated: !row.active,
    scrubbed,
  };
}

export type ScrubUserResult =
  | { status: "ok"; reassignment: ReassignmentResult | null }
  | { status: "not_found" }
  | { status: "already_scrubbed" }
  | { status: "cannot_erase_self" }
  | { status: "last_platform_admin" }
  | { status: "invalid_successor" };

/** §3 erasure refusal: does the user hold the platform-admin role — a SCIM-synced membership of
 *  a group that `role_mappings` maps to `platform_admin`, or of the bootstrap admin group —
 *  exactly as resolveRolesForUsers (lib/auth.ts) and getPlatformAdminUserIds resolve it
 *  (invariant 1)? Membership alone: the row's own `active`/`scrubbed_at` are not consulted here. */
async function holdsPlatformAdminRole(client: PoolClient, userId: string, bootstrapAdminGroup: string | undefined): Promise<boolean> {
  const { rows } = await client.query(
    `select 1
       from group_members gm
       join groups g on g.id = gm.group_id
      where gm.user_id = $1
        and (exists (select 1 from role_mappings rm where rm.group_external_id = g.external_id and rm.role = 'platform_admin')
             or ($2::text is not null and g.external_id = $2))
      limit 1`,
    [userId, bootstrapAdminGroup || null],
  );
  return rows.length > 0;
}

/** GDPR erasure — "Delete user info" (§3). De-identifies the user's row: display name becomes
 *  "Deleted User" (which cascades to every challenge/solution/comment via the display_name
 *  join), personal fields are nulled, user_name is replaced with a non-PII token, the account
 *  is deactivated, and scrubbed_at is stamped so reconciliation never restores it from Entra.
 *  The row (id + external_id) is kept so the audit trail still links, and the audit_log itself
 *  is exempt from erasure (§15). Irreversible; platform-admin-only (gated in the route).
 *  `handover` names the optional successor for open assignments (§3, erasure-reassignment.ts).
 *  Two refusals come first (§3, v1.16): the acting admin cannot erase their own account, and an
 *  erasure that would leave no active, not-erased platform admin is refused. */
export async function scrubUser(pool: Pool, adminUserId: string, userId: string, handover?: SuccessorHandover): Promise<ScrubUserResult> {
  const { rows } = await pool.query<{ id: string; scrubbed_at: Date | null }>(`select id, scrubbed_at from users where id = $1`, [userId]);
  const row = rows[0];
  if (!row) return { status: "not_found" };
  if (row.scrubbed_at) return { status: "already_scrubbed" };

  return inTransaction(pool, async (client) => {
    // §3 refusals, all checked before anything changes (the transaction is still empty).
    // Self-erasure would end the session mid-request with an irreversible result.
    if (adminUserId.toLowerCase() === userId.toLowerCase()) return { status: "cannot_erase_self" };
    // The last active platform admin: the target holds the role and no OTHER active, not-erased
    // platform admin remains (getPlatformAdminUserIds already filters to active + not scrubbed).
    const bootstrapAdminGroup = process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP;
    if (await holdsPlatformAdminRole(client, userId, bootstrapAdminGroup)) {
      const remaining = (await getPlatformAdminUserIds(client, bootstrapAdminGroup)).filter((id) => id !== userId);
      if (remaining.length === 0) return { status: "last_platform_admin" };
    }
    if (handover && !(await isEligibleSuccessor(client, handover.successorId, userId))) return { status: "invalid_successor" };
    await client.query(
      `update users
          set display_name = 'Deleted User',
              user_name = 'deleted-' || id,
              email = null,
              department = null,
              job_title = null,
              office_location = null,   -- §13.8 directory profile: personal data, scrubbed like the photo
              photo = null,
              photo_etag = null,
              last_seen_at = null,      -- §14.5 presence: a retained "Deleted User was last
              last_route = null,        -- online at 14:32" would defeat the erasure
              -- §3: the per-user seen markers and notification preferences live on the row and
              -- go with it. The markers are nullable and are nulled. E-mail notifications are
              -- switched off — no address is left to send to; the notify_followed_* flags are
              -- NOT NULL, so they fall back to their column defaults (no user-chosen value kept).
              triage_seen_at = null,
              challenges_seen_at = null,
              system_log_seen_at = null,
              quick_start_seen_at = null,
              whats_new_seen_version = null,   -- §13.9 What's new marker
              whats_new_since_date = null,     -- and its one-time rollout boundary
              email_notifications_enabled = false,
              notify_followed_comments = default,
              notify_followed_status = default,
              notify_followed_solutions = default,
              -- §13.10: the per-user survey state goes too. Responses are untouched — they
              -- reference no one, so there is nothing of this user in them to erase.
              surveys_enabled = default,
              survey_last_shown_at = null,
              survey_offer = null,
              survey_self_shown_at = null,
              -- §23: the gamification switches back to their defaults, the toast marker nulled.
              gamification_public = default,
              notify_achievements = default,
              achievements_seen_at = null,
              -- §38.12: the feature-ideas name switch back to its default.
              feature_ideas_named = default,
              active = false,
              deactivated_at = coalesce(deactivated_at, now()),
              -- §3 Sign out everywhere: every live session token of the erased user is refused
              -- at its next request, closing the window between the active flip and that request.
              sessions_valid_from = now(),
              scim_synced = false,
              scrubbed_at = now(),
              updated_at = now()
        where id = $1`,
      [userId],
    );
    // The transient per-day activity detail is personal data too (§14.5). Only the aggregate
    // presence_daily counts survive, and those carry no user ids — nothing to erase there.
    await client.query(`delete from user_activity_days where user_id = $1`, [userId]);
    // §13.10: which features the user has used is personal data; the survey responses are not.
    await client.query(`delete from user_feature_uses where user_id = $1`, [userId]);
    // §14.7: the system log is mutable operational telemetry, so — unlike audit_log — the
    // user's actor snapshots are scrubbed and their rows detached from the user id.
    await scrubSystemEventsForUser(client, userId);
    // §22.3: AI usage telemetry keeps its counts but loses the person it ran for.
    await client.query(`update ai_usage set user_id = null where user_id = $1`, [userId]);
    await client.query(`update ai_results set requested_by = null where requested_by = $1`, [userId]);
    // §38.12: the person's pending, declined and merged proposals go — their text is personal and
    // serves no one else. Planned ideas are admin-written product copy now: they stay, with the raw
    // text cleared and no proposer shown (the scrubbed row is never named). Votes stay, unnamed.
    await client.query(`delete from feature_ideas where author_id = $1 and status <> 'planned'`, [userId]);
    await client.query(`update feature_ideas set description = null, updated_at = now() where author_id = $1 and status = 'planned'`, [userId]);
    // §23.9: the user's points ledger and badges go — the only DELETE the app role holds on them.
    await client.query(`delete from gamification_ledger where user_id = $1`, [userId]);
    await client.query(`delete from user_badges where user_id = $1`, [userId]);
    // §34.7: a topic follow is a preference, like the toggles reset above; the event-18 markers go
    // with it. The topics they tagged keep `added_by` pointing at the de-identified row.
    await client.query(`delete from topic_follows where user_id = $1`, [userId]);
    await client.query(`delete from topic_notices where user_id = $1`, [userId]);
    // §25.13: the person's AI agent grants are revoked (audited, reason "erased") and deleted —
    // their tokens and pending authorizations cascade. mcp_client_name is not personal data.
    await eraseUserGrants(client, userId, adminUserId);
    // §3 optional successor: hand over the open assignments the successor can see, same transaction.
    const reassignment = handover ? await handOverOpenAssignments(client, adminUserId, userId, handover) : null;
    await appendAudit(client, {
      actorUserId: adminUserId,
      action: "user.scrubbed",
      targetType: "user",
      targetId: userId,
      after: {
        scrubbed: true,
        reassignedTo: reassignment?.successorId ?? null,
        reassignedCount: reassignment?.moved.length ?? 0,
        skippedCount: reassignment?.skipped.length ?? 0,
      },
    });
    return { status: "ok", reassignment };
  });
}

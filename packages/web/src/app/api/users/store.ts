// Data layer for /api/users (INNOBOX_SPEC.md §7.3): the searchable active-user directory
// backing the namespace admin's assignment picker. Not admin-gated at this layer — any
// authenticated user may search (enforced in route.ts); this module only returns the
// minimal id/displayName/email projection, never roles or namespace membership.
import type { Pool } from "pg";
import { appendAudit } from "../../../lib/audit";
import { inTransaction } from "../../../lib/db";
import { scrubSystemEventsForUser } from "../admin/system-log/store";
import { handOverOpenAssignments, isEligibleSuccessor, type ReassignmentResult, type SuccessorHandover } from "./erasure-reassignment";

export interface UserSearchResult {
  id: string;
  displayName: string;
  email: string | null;
}

const RESULT_LIMIT = 10;

export async function searchActiveUsers(pool: Pool, query: string): Promise<UserSearchResult[]> {
  const { rows } = await pool.query<{ id: string; display_name: string; email: string | null }>(
    `select id, display_name, email from users
      where active = true and (display_name ilike $1 or email ilike $1)
      order by display_name limit ${RESULT_LIMIT}`,
    [`%${query}%`],
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
    [`%${query}%`],
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
  | { status: "invalid_successor" };

/** GDPR erasure — "Delete user info" (§3). De-identifies the user's row: display name becomes
 *  "Deleted User" (which cascades to every challenge/solution/comment via the display_name
 *  join), personal fields are nulled, user_name is replaced with a non-PII token, the account
 *  is deactivated, and scrubbed_at is stamped so reconciliation never restores it from Entra.
 *  The row (id + external_id) is kept so the audit trail still links, and the audit_log itself
 *  is exempt from erasure (§15). Irreversible; platform-admin-only (gated in the route).
 *  `handover` names the optional successor for open assignments (§3, erasure-reassignment.ts). */
export async function scrubUser(pool: Pool, adminUserId: string, userId: string, handover?: SuccessorHandover): Promise<ScrubUserResult> {
  const { rows } = await pool.query<{ id: string; scrubbed_at: Date | null }>(`select id, scrubbed_at from users where id = $1`, [userId]);
  const row = rows[0];
  if (!row) return { status: "not_found" };
  if (row.scrubbed_at) return { status: "already_scrubbed" };

  return inTransaction(pool, async (client) => {
    // §3 successor rules, checked before anything changes (the transaction is still empty).
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
              -- go with it. The markers are nullable and are nulled; the preference flags are
              -- NOT NULL, so they fall back to their column defaults (no user-chosen value kept).
              triage_seen_at = null,
              challenges_seen_at = null,
              system_log_seen_at = null,
              quick_start_seen_at = null,
              email_notifications_enabled = default,
              notify_followed_comments = default,
              notify_followed_status = default,
              notify_followed_solutions = default,
              active = false,
              deactivated_at = coalesce(deactivated_at, now()),
              scim_synced = false,
              scrubbed_at = now(),
              updated_at = now()
        where id = $1`,
      [userId],
    );
    // The transient per-day activity detail is personal data too (§14.5). Only the aggregate
    // presence_daily counts survive, and those carry no user ids — nothing to erase there.
    await client.query(`delete from user_activity_days where user_id = $1`, [userId]);
    // §14.7: the system log is mutable operational telemetry, so — unlike audit_log — the
    // user's actor snapshots are scrubbed and their rows detached from the user id.
    await scrubSystemEventsForUser(client, userId);
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

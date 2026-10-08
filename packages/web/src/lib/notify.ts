// Notification dispatch (INNOBOX_SPEC.md §12.1): every event writes an in-app `notifications`
// row per recipient AND queues a `notification_outbox` row the worker sweeps for e-mail
// (§12). This module owns RECIPIENT computation (dedup, actor-exclusion via
// @innobox/shared's finalizeRecipients, and visibility-dropping, invariant 2) — callers own
// MESSAGE construction, since they already have the full challenge/solution context (a
// solution has no title of its own; only the caller knows whether to reference the parent
// challenge's). Messages must never leak an anonymous author's identity (§9) — callers pass
// already-masked display names.
import type { Pool, PoolClient } from "pg";
import {
  NOTIFICATION_PREFERENCE_COLUMN,
  applyPreferenceMute,
  commentNotificationMessage,
  finalizeRecipients,
  type NotificationPayload,
  type NotificationPreference,
  type NotificationType,
} from "@innobox/shared";
import { isParentVisible, type Viewer } from "../app/api/challenges/store";

type Db = Pool | PoolClient;

async function writeNotifications(db: Db, userIds: string[], type: NotificationType, payload: NotificationPayload): Promise<void> {
  for (const userId of userIds) {
    await db.query(`insert into notifications (user_id, type, payload) values ($1, $2, $3)`, [userId, type, JSON.stringify(payload)]);
    await db.query(`insert into notification_outbox (user_id, type, payload) values ($1, $2, $3)`, [userId, type, JSON.stringify(payload)]);
  }
}

export async function getNamespaceAdminUserIds(db: Db, namespaceId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `select distinct gm.user_id
       from group_members gm
       join groups g on g.id = gm.group_id
       join role_mappings rm on rm.group_external_id = g.external_id
      where (rm.role = 'namespace_admin' and rm.namespace_id = $1) or rm.role = 'platform_admin'`,
    [namespaceId],
  );
  return rows.map((r) => r.user_id);
}

export async function getNamespaceCommitteeUserIds(db: Db, namespaceId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `select distinct gm.user_id
       from group_members gm
       join groups g on g.id = gm.group_id
       join role_mappings rm on rm.group_external_id = g.external_id
      where rm.role = 'committee' and rm.namespace_id = $1`,
    [namespaceId],
  );
  return rows.map((r) => r.user_id);
}

export async function getFollowerUserIds(db: Db, parentType: "challenge" | "solution", parentId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `select user_id from follows where parent_type = $1 and parent_id = $2`,
    [parentType, parentId],
  );
  return rows.map((r) => r.user_id);
}

export async function getOtherCommenterUserIds(db: Db, parentType: "challenge" | "solution", parentId: string): Promise<string[]> {
  const { rows } = await db.query<{ author_id: string }>(
    `select distinct author_id from comments where parent_type = $1 and parent_id = $2`,
    [parentType, parentId],
  );
  return rows.map((r) => r.author_id);
}

export interface NotifyContext {
  pool: Pool;
  actorId: string | null;
  /** Resolves a user's RoleSet for the visibility check — injected so this module doesn't
   *  duplicate getSessionUser's role-resolution SQL for arbitrary (non-session) user ids. */
  resolveRoles: (userId: string) => Promise<Viewer["roles"]>;
}

/** §12.1 per-event preferences: which mutable event this dispatch is, and who it is a duty for
 *  (never filtered — admins/committee on a new solution, the assignee on a status change). */
export interface PreferenceMute {
  preference: NotificationPreference;
  exempt?: string[];
}

/** The recipients who switched this preference off. The column comes from a fixed map. */
async function optedOutOf(db: Db, preference: NotificationPreference, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const column = NOTIFICATION_PREFERENCE_COLUMN[preference];
  const { rows } = await db.query<{ id: string }>(`select id from users where id = any($1::uuid[]) and not ${column}`, [userIds]);
  return new Set(rows.map((r) => r.id));
}

/**
 * Compute the final recipient list for an event (§12.1: actors never notify themselves,
 * recipients deduplicated, recipients outside the item's visibility dropped) and write both
 * the in-app notification and the outbox row for each. `candidates` is whatever raw
 * author/admin/committee/assignee/follower ids the caller gathered for this event.
 */
export async function dispatchEvent(
  ctx: NotifyContext,
  visibilityScope: { parentType: "challenge" | "solution"; parentId: string },
  candidates: string[],
  type: NotificationType,
  payload: NotificationPayload,
  mute?: PreferenceMute,
): Promise<void> {
  const recipients = await finalRecipients(ctx, visibilityScope, candidates, mute);
  if (recipients.length === 0) return;
  await writeNotifications(ctx.pool, recipients, type, payload);
}

/** Dedup + actor exclusion, then the visibility drop (invariant 2), then the §12.1 preference
 *  mute — row-level, at insert time: an opted-out recipient gets neither the inbox row nor the
 *  outbox row, so there is nothing for the bell or the e-mail sweep to deliver. */
async function finalRecipients(
  ctx: NotifyContext,
  visibilityScope: { parentType: "challenge" | "solution"; parentId: string },
  candidates: string[],
  mute?: PreferenceMute,
): Promise<string[]> {
  const deduped = finalizeRecipients(candidates, ctx.actorId);
  const visible: string[] = [];
  for (const userId of deduped) {
    const roles = await ctx.resolveRoles(userId);
    if (await isParentVisible(ctx.pool, { userId, roles }, visibilityScope.parentType, visibilityScope.parentId)) {
      visible.push(userId);
    }
  }
  return mute ? applyPreferenceMute(visible, await optedOutOf(ctx.pool, mute.preference, visible), new Set(mute.exempt ?? [])) : visible;
}

// ── §12.1 event 6: coalesced comment notifications ──────────────────────────────────────

export interface CommentNotification {
  /** The item the comment was posted on — the coalescing key. */
  parentType: "challenge" | "solution";
  parentId: string;
  /** The challenge whose page shows it (itself, or a solution's parent) — opening it reads the row. */
  challengeId: string;
  challengeNumber: string; // "CH-412"
  challengeTitle: string;
  /** The commenter's display name. Comments are never anonymous (§9). */
  latestBy: string;
  link: string;
}

/** The refreshed message, rendered in SQL with the same text as `commentNotificationMessage` for
 *  count ≥ 2 (a dbtest pins the two together). `n` is the NEW count. */
const COALESCED_MESSAGE_SQL = (n: string, p: string) =>
  `format('%s new comments on %s "%s" — latest by %s.', ${n}, ${p}->>'challengeNumber', ${p}->>'challengeTitle', ${p}->>'latestBy')`;

/**
 * Event 6 delivery: one UNREAD inbox row per recipient per item. The first comment inserts the
 * row and its outbox row (one e-mail); every further comment on the same item while that row is
 * unread refreshes it IN PLACE — count + 1, latest commenter, created_at bumped so it re-sorts to
 * the top — through a single atomic upsert against the migration-0024 partial unique index, and
 * writes no outbox row, so the recipient is e-mailed at most once per item until they read it.
 * Once read, the next comment starts a fresh row (and a fresh e-mail).
 */
export async function dispatchCoalescedComment(
  ctx: NotifyContext,
  candidates: string[],
  comment: CommentNotification,
  mute?: PreferenceMute,
): Promise<void> {
  const recipients = await finalRecipients(ctx, { parentType: comment.parentType, parentId: comment.parentId }, candidates, mute);
  for (const userId of recipients) {
    const payload = {
      message: commentNotificationMessage(1, comment.challengeNumber, comment.challengeTitle, comment.latestBy),
      link: comment.link,
      parentType: comment.parentType,
      parentId: comment.parentId,
      challengeId: comment.challengeId,
      challengeNumber: comment.challengeNumber,
      challengeTitle: comment.challengeTitle,
      latestBy: comment.latestBy,
      latestAt: new Date().toISOString(),
      count: 1,
    };
    const newCount = `(coalesce((notifications.payload->>'count')::int, 1) + 1)`;
    const { rows } = await ctx.pool.query<{ inserted: boolean }>(
      `insert into notifications (user_id, type, payload) values ($1, 'comment_posted', $2::jsonb)
       on conflict (user_id, (payload->>'parentType'), (payload->>'parentId'))
         where read_at is null and type = 'comment_posted'
       do update set
         payload = notifications.payload
           || jsonb_build_object(
                'count', ${newCount},
                'latestBy', excluded.payload->>'latestBy',
                'latestAt', excluded.payload->>'latestAt',
                'challengeTitle', excluded.payload->>'challengeTitle',
                'message', ${COALESCED_MESSAGE_SQL(newCount, "excluded.payload")}),
         created_at = now()
       returning (xmax = 0) as inserted`,
      [userId, JSON.stringify(payload)],
    );
    // A refresh preserves the delivery bookkeeping: the e-mail went out with the first comment.
    if (rows[0]?.inserted) {
      await ctx.pool.query(`insert into notification_outbox (user_id, type, payload) values ($1, 'comment_posted', $2::jsonb)`, [userId, JSON.stringify(payload)]);
    }
  }
}

/** §12.1 read action: opening a challenge's page reads the viewer's unread comment rows for the
 *  challenge itself AND its solutions (the page shows both). */
export async function markCommentNotificationsReadForChallenge(db: Db, userId: string, challengeId: string): Promise<void> {
  await db.query(
    `update notifications set read_at = now()
      where user_id = $1 and type = 'comment_posted' and read_at is null and payload->>'challengeId' = $2`,
    [userId, challengeId],
  );
}

/** Single-recipient events (assignment) skip the visibility check — the assignee is, by
 *  definition, someone the admin just granted per-item powers to (§4.2). */
export async function dispatchToUser(ctx: NotifyContext, userId: string, type: NotificationType, payload: NotificationPayload): Promise<void> {
  if (userId === ctx.actorId) return;
  await writeNotifications(ctx.pool, [userId], type, payload);
}

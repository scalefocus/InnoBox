// Notification dispatch (INNOBOX_SPEC.md §12.1): every event writes an in-app `notifications`
// row per recipient AND queues a `notification_outbox` row the worker sweeps for e-mail
// (§12). This module owns RECIPIENT computation (dedup, actor-exclusion via
// @innobox/shared's finalizeRecipients, and visibility-dropping, invariant 2) — callers own
// MESSAGE construction, since they already have the full challenge/solution context (a
// solution has no title of its own; only the caller knows whether to reference the parent
// challenge's). Messages must never leak an anonymous author's identity (§9) — callers pass
// already-masked display names.
import type { Pool, PoolClient } from "pg";
import { finalizeRecipients, type NotificationPayload, type NotificationType } from "@innobox/shared";
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
): Promise<void> {
  const deduped = finalizeRecipients(candidates, ctx.actorId);
  const recipients: string[] = [];
  for (const userId of deduped) {
    const roles = await ctx.resolveRoles(userId);
    if (await isParentVisible(ctx.pool, { userId, roles }, visibilityScope.parentType, visibilityScope.parentId)) {
      recipients.push(userId);
    }
  }
  if (recipients.length === 0) return;
  await writeNotifications(ctx.pool, recipients, type, payload);
}

/** Single-recipient events (assignment) skip the visibility check — the assignee is, by
 *  definition, someone the admin just granted per-item powers to (§4.2). */
export async function dispatchToUser(ctx: NotifyContext, userId: string, type: NotificationType, payload: NotificationPayload): Promise<void> {
  if (userId === ctx.actorId) return;
  await writeNotifications(ctx.pool, [userId], type, payload);
}

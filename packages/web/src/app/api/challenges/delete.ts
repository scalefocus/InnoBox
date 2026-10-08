// §10.3 admin delete: the ONE path in the app that permanently destroys a challenge or a
// solution. Platform admins only — and a non-platform-admin caller (or any caller asking
// about an item they cannot see) gets `not_found`, never `forbidden`, so this endpoint can
// never be used as an existence oracle for a namespace-restricted item (invariant 2).
//
// Everything goes in ONE transaction (all-or-nothing): the whole child subtree, the row
// itself, the §8.3 un-solve when the deleted solution was the implemented one, and the audit
// row. The object-store purge runs AFTER the commit — a failed purge leaves unreachable bytes
// (their metadata row is gone, so nothing can serve them), which is strictly better than
// rolling back a delete the admin was told had happened.
//
// The audit row deliberately carries NO content — no title, description, client name, comment
// bodies, or filenames. This action exists to destroy sensitive content and `audit_log` is
// exempt from GDPR erasure (§3, §15), so a content snapshot there would defeat the purpose.
// Metadata, cascade counts, and the admin's mandatory reason only.
import type { Pool, PoolClient } from "pg";
import { notificationLinkScope, parentStatusAfterSolutionDelete, type ChallengeStatus, type SolutionStatus } from "@innobox/shared";
import { appendAudit } from "../../../lib/audit";
import { inTransaction } from "../../../lib/db";
import type { StorageClient } from "../../../lib/storage";
import type { Viewer } from "./store";

export interface DeleteDeps {
  pool: Pool;
  storage: StorageClient;
}

/** Per-table tally of what the cascade removed — the audit row's only quantitative record of
 *  a subtree that no longer exists. */
export interface CascadeCounts {
  solutions: number;
  comments: number;
  likes: number;
  follows: number;
  attachments: number;
  notifications: number;
  outbox: number;
  uploadSessions: number;
  /** §12.4 channel-webhook deliveries targeting the subtree (any status). */
  webhookDeliveries: number;
}

export type DeleteChallengeResult = { status: "ok"; counts: CascadeCounts } | { status: "not_found" };

export type DeleteSolutionResult =
  | { status: "ok"; counts: CascadeCounts; challengeRevertedToValid: boolean }
  | { status: "not_found" };

/** Object-store work deferred until after the transaction commits. */
interface Purge {
  objectKeys: string[];
  sessions: { objectKey: string; s3UploadId: string }[];
}

/**
 * Delete every child row of the given challenge/solution ids (polymorphic children carry
 * `parent_type` + `parent_id` and no FK, so the cascade is explicit app SQL rather than
 * ON DELETE CASCADE). Returns the counts plus the object-store work to run post-commit.
 */
async function deleteChildren(
  client: PoolClient,
  challengeIds: string[],
  solutionIds: string[],
): Promise<{ counts: Omit<CascadeCounts, "solutions" | "notifications" | "outbox">; purge: Purge }> {
  const params = [challengeIds, solutionIds];
  const parentMatch = `((parent_type = 'challenge' and parent_id = any($1::uuid[])) or (parent_type = 'solution' and parent_id = any($2::uuid[])))`;

  const comments = await client.query(`delete from comments where ${parentMatch}`, params);
  const likes = await client.query(`delete from likes where ${parentMatch}`, params);
  const follows = await client.query(`delete from follows where ${parentMatch}`, params);

  // Tombstones go too (the §11 retention rule is carved out here, and only here); their MinIO
  // objects are purged below — `infected` rows were already purged at scan time, and
  // DeleteObject on an absent key is a no-op, so one uniform purge is safe.
  const attachments = await client.query<{ object_key: string }>(
    `delete from attachments where ${parentMatch} returning object_key`,
    params,
  );

  // Only BOUND chunked-upload sessions belong to this subtree (a staged one has no parent yet,
  // and is reaped by the §11 GC sweeps instead).
  const sessions = await client.query<{ object_key: string; s3_upload_id: string }>(
    `delete from attachment_uploads where ${parentMatch} returning object_key, s3_upload_id`,
    params,
  );

  // §12.4: every webhook delivery row targeting the subtree (polymorphic entity id, no FK).
  const webhookDeliveries = await client.query(
    `delete from webhook_deliveries where (entity_type = 'challenge' and entity_id = any($1::uuid[])) or (entity_type = 'solution' and entity_id = any($2::uuid[]))`,
    params,
  );

  return {
    counts: {
      comments: comments.rowCount ?? 0,
      likes: likes.rowCount ?? 0,
      follows: follows.rowCount ?? 0,
      attachments: attachments.rowCount ?? 0,
      uploadSessions: sessions.rowCount ?? 0,
      webhookDeliveries: webhookDeliveries.rowCount ?? 0,
    },
    purge: {
      objectKeys: attachments.rows.map((r) => r.object_key),
      sessions: sessions.rows.map((r) => ({ objectKey: r.object_key, s3UploadId: r.s3_upload_id })),
    },
  };
}

/**
 * Remove the in-app notifications and still-unsent outbox rows that point at the deleted
 * subtree, so no inbox item survives linking to an entity that no longer exists (§10.3,
 * §12.1). Rows are matched on their §12.1 deep link — the only entity reference a payload
 * carries. Already-**sent** outbox rows are dispatch history and are left alone: the mail
 * they describe has already left the building.
 */
async function deleteNotifications(
  client: PoolClient,
  scope: { exact: string; prefix: string | null },
): Promise<{ notifications: number; outbox: number }> {
  const match = `(payload->>'link' = $1 or ($2::text is not null and payload->>'link' like $2 || '%'))`;
  const params = [scope.exact, scope.prefix];
  const inbox = await client.query(`delete from notifications where ${match}`, params);
  const outbox = await client.query(`delete from notification_outbox where ${match} and status = 'pending'`, params);
  return { notifications: inbox.rowCount ?? 0, outbox: outbox.rowCount ?? 0 };
}

/** Best-effort object-store cleanup after the DB transaction commits. A failure here leaves
 *  bytes that nothing can reach (the metadata row is gone), so it is logged, not thrown. */
async function runPurge(storage: StorageClient, purge: Purge): Promise<void> {
  for (const key of purge.objectKeys) {
    await storage.deleteObject(key).catch((err) => {
      console.error(JSON.stringify({ level: "error", msg: "deleted attachment object purge failed", objectKey: key, error: String(err) }));
    });
  }
  for (const session of purge.sessions) {
    await storage.abortMultipartUpload(session.objectKey, session.s3UploadId).catch((err) => {
      console.error(
        JSON.stringify({ level: "error", msg: "deleted upload session abort failed", objectKey: session.objectKey, error: String(err) }),
      );
    });
  }
}

/**
 * Permanently delete a challenge and everything under it — all of its solutions regardless of
 * status, and every comment, like, follow, attachment, notification, and unsent outbox row on
 * the challenge or those solutions (§10.3).
 */
export async function deleteChallenge(deps: DeleteDeps, admin: Viewer, number: string, reason: string): Promise<DeleteChallengeResult> {
  if (!admin.roles.isPlatformAdmin) return { status: "not_found" };

  const { rows } = await deps.pool.query<{ id: string; number: string; status: string; author_id: string; namespace_id: string }>(
    `select id, number::text, status, author_id, namespace_id from challenges where number = $1`,
    [number],
  );
  const challenge = rows[0];
  if (!challenge) return { status: "not_found" };

  const { counts, purge } = await inTransaction(deps.pool, async (client) => {
    const { rows: solutionRows } = await client.query<{ id: string }>(`select id from solutions where challenge_id = $1`, [challenge.id]);
    const solutionIds = solutionRows.map((r) => r.id);

    const children = await deleteChildren(client, [challenge.id], solutionIds);
    // A challenge's scope covers its own link plus every `#SOL-<n>` link beneath it.
    const notifications = await deleteNotifications(client, notificationLinkScope({ challengeNumber: challenge.number }));

    await client.query(`delete from solutions where challenge_id = $1`, [challenge.id]);
    await client.query(`delete from challenges where id = $1`, [challenge.id]);

    const counts: CascadeCounts = { ...children.counts, solutions: solutionIds.length, ...notifications };
    await appendAudit(client, {
      actorUserId: admin.userId,
      action: "challenge.deleted",
      targetType: "challenge",
      targetId: challenge.id,
      before: {
        number: `CH-${challenge.number}`,
        entityType: "challenge",
        authorId: challenge.author_id,
        status: challenge.status,
        namespaceId: challenge.namespace_id,
      },
      after: { reason, cascade: counts },
    });
    return { counts, purge: children.purge };
  });

  await runPurge(deps.storage, purge);
  return { status: "ok", counts };
}

/**
 * Permanently delete one solution and its own children, leaving the parent challenge standing
 * (§10.3). When the deleted solution was the `implemented` one of a `solved` challenge, the
 * challenge is un-solved back to `valid` in the same transaction — siblings closed as
 * `not_selected` stay closed, and the §8.3 single-winner slot is free again.
 */
export async function deleteSolution(deps: DeleteDeps, admin: Viewer, number: string, reason: string): Promise<DeleteSolutionResult> {
  if (!admin.roles.isPlatformAdmin) return { status: "not_found" };

  const { rows } = await deps.pool.query<{
    id: string;
    number: string;
    status: string;
    author_id: string;
    challenge_id: string;
    challenge_number: string;
    challenge_status: string;
    namespace_id: string;
  }>(
    `select s.id, s.number::text, s.status, s.author_id,
            c.id as challenge_id, c.number::text as challenge_number, c.status as challenge_status, c.namespace_id
       from solutions s
       join challenges c on c.id = s.challenge_id
      where s.number = $1`,
    [number],
  );
  const solution = rows[0];
  if (!solution) return { status: "not_found" };

  const revertTo = parentStatusAfterSolutionDelete({
    solutionStatus: solution.status as SolutionStatus,
    challengeStatus: solution.challenge_status as ChallengeStatus,
  });

  const { counts, purge } = await inTransaction(deps.pool, async (client) => {
    const children = await deleteChildren(client, [], [solution.id]);
    const notifications = await deleteNotifications(
      client,
      notificationLinkScope({ challengeNumber: solution.challenge_number, solutionNumber: solution.number }),
    );

    await client.query(`delete from solutions where id = $1`, [solution.id]);

    if (revertTo !== null) {
      await client.query(
        `update challenges set status = $2, resolved_at = null, updated_at = now(), status_changed_at = now() where id = $1`,
        [solution.challenge_id, revertTo],
      );
      await appendAudit(client, {
        actorUserId: admin.userId,
        action: "challenge.status_changed",
        targetType: "challenge",
        targetId: solution.challenge_id,
        before: { status: solution.challenge_status },
        after: { status: revertTo, override: true, trigger: "solution_deleted" },
      });
    }

    const counts: CascadeCounts = { ...children.counts, solutions: 0, ...notifications };
    await appendAudit(client, {
      actorUserId: admin.userId,
      action: "solution.deleted",
      targetType: "solution",
      targetId: solution.id,
      before: {
        number: `SOL-${solution.number}`,
        entityType: "solution",
        authorId: solution.author_id,
        status: solution.status,
        namespaceId: solution.namespace_id,
        challengeId: solution.challenge_id,
      },
      after: { reason, cascade: counts },
    });
    return { counts, purge: children.purge };
  });

  await runPurge(deps.storage, purge);
  return { status: "ok", counts, challengeRevertedToValid: revertTo !== null };
}

// The §10.3 purge — the ONE path that permanently destroys a challenge or a solution — and the
// §10.4 trash-time cleanup it shares rows with (INNOBOX_SPEC.md §10.3, §10.4). Shared so the web
// tier (Delete permanently, from the danger zone or the trash) and the worker (the daily purge of
// items whose 30 days are up) run exactly the same cascade. Authorization is the caller's job:
// nothing here checks who is asking.
//
// Everything goes in ONE transaction (all-or-nothing): the whole child subtree, the row itself,
// the §8.3 un-solve when the purged solution was the implemented one, and the audit row. The
// object-store purge runs AFTER the commit — a failed purge leaves unreachable bytes (their
// metadata row is gone, so nothing can serve them), which is strictly better than rolling back a
// delete the admin was told had happened.
//
// The audit row deliberately carries NO content — no title, description, client name, comment
// bodies, or filenames. This action exists to destroy sensitive content and `audit_log` is
// exempt from GDPR erasure (§3, §15), so a content snapshot there would defeat the purpose.
// Metadata, cascade counts, and the admin's mandatory reason only.
import { appendAudit } from "./audit.js";
import { notificationLinkScope, parentStatusAfterSolutionDelete, type ChallengeStatus, type SolutionStatus } from "./challenges.js";
import { deleteAiResults } from "./ai.js";
import type { DbClient, DbPool } from "./email-graph.js";

/** The object-store calls the purge needs (the web StorageClient and the worker S3 client both fit). */
export interface PurgeStorage {
  deleteObject(key: string): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}

/** Per-table tally of what the cascade removed — the audit row's only quantitative record of
 *  a subtree that no longer exists. */
export interface CascadeCounts {
  solutions: number;
  comments: number;
  likes: number;
  /** §26.9: the subtree's hypes. Budgets are not refunded; the ledger is untouched. */
  hypes: number;
  follows: number;
  attachments: number;
  notifications: number;
  outbox: number;
  uploadSessions: number;
  /** §12.4 channel-webhook deliveries targeting the subtree (any status). */
  webhookDeliveries: number;
  /** §22.11/§22.13 cached AI results (triage notes, discussion summaries) of the subtree. */
  aiResults: number;
}

/** Who asked for the purge and why (§10.3 audit). `manual` is Delete permanently — from the
 *  danger zone or the trash — with the admin as actor; `retention` is the worker's purge at the
 *  end of the trash window, with no user actor and the reason given when the item was trashed. */
export interface PurgeRequest {
  actorUserId: string | null;
  reason: string;
  trigger: "manual" | "retention";
  /** The retention purge only: go ahead only while the item is still in the trash and was
   *  trashed at or before this instant — an admin may have restored it since it was listed. */
  trashedNoLaterThan?: Date;
}

/** True when a `retention` purge must stand down for this row (restored, or re-trashed later). */
function retentionStandsDown(request: PurgeRequest, trashedAt: Date | null): boolean {
  if (!request.trashedNoLaterThan) return false;
  return trashedAt === null || trashedAt.getTime() > request.trashedNoLaterThan.getTime();
}

export type PurgeChallengeResult = { status: "ok"; counts: CascadeCounts } | { status: "not_found" };

export type PurgeSolutionResult = { status: "ok"; counts: CascadeCounts; challengeRevertedToValid: boolean } | { status: "not_found" };

/** Object-store work deferred until after the transaction commits. */
interface ObjectPurge {
  objectKeys: string[];
  sessions: { objectKey: string; s3UploadId: string }[];
}

async function inTransaction<T>(pool: DbPool, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The subtree a cascade or a trash-time cleanup covers: the challenge(s) and solution(s) by id,
 *  plus the §12.1 link scope of the item at its root. */
export interface Subtree {
  challengeIds: string[];
  solutionIds: string[];
  linkScope: { exact: string; prefix: string | null };
}

/**
 * The notification rows that target a subtree. A row targets it when EITHER
 *  - its payload names an item of the subtree as its target, `parentType`/`parentId` — every
 *    notification about a challenge or solution carries one (web lib/notify.ts `withTarget`, the
 *    scan-failure writer) — or, for a comment row (event 6), names a challenge of the subtree as
 *    its `challengeId`; or
 *  - its §12.1 deep link is the item's (`/challenges/<n>`, or `…#SOL-<m>` for a solution). This
 *    is the fallback for rows written before payloads carried a target.
 * Params: $1 exact link, $2 link prefix (or null), $3 challenge ids, $4 solution ids.
 */
const SUBTREE_NOTIFICATION_MATCH = `(payload->>'link' = $1
      or ($2::text is not null and payload->>'link' like $2 || '%')
      or (payload->>'parentType' = 'challenge' and payload->>'parentId' = any($3::text[]))
      or (payload->>'parentType' = 'solution' and payload->>'parentId' = any($4::text[]))
      or payload->>'challengeId' = any($3::text[]))`;

function subtreeNotificationParams(subtree: Subtree): unknown[] {
  return [subtree.linkScope.exact, subtree.linkScope.prefix, subtree.challengeIds, subtree.solutionIds];
}

/**
 * Removes every still-unsent e-mail and channel post about the subtree (§10.3 cascade, §10.4 trash
 * time), so nothing about it can go out afterwards. "Unsent" is every outbox row that is not
 * `sent` — `pending` and `failed` alike — and every webhook delivery that is not `sent`; already
 * sent rows are dispatch history and stay: that mail has already left the building.
 */
export async function removeUnsentAbout(client: DbClient, subtree: Subtree): Promise<{ outbox: number; webhookDeliveries: number }> {
  const outbox = await client.query(
    `delete from notification_outbox where ${SUBTREE_NOTIFICATION_MATCH} and status <> 'sent'`,
    subtreeNotificationParams(subtree),
  );
  const webhooks = await client.query(
    `delete from webhook_deliveries
      where status <> 'sent'
        and ((entity_type = 'challenge' and entity_id = any($1::uuid[])) or (entity_type = 'solution' and entity_id = any($2::uuid[])))`,
    [subtree.challengeIds, subtree.solutionIds],
  );
  return { outbox: outbox.rowCount ?? 0, webhookDeliveries: webhooks.rowCount ?? 0 };
}

/** Drops the bound chunked-upload sessions of the subtree and returns them, so the caller can
 *  abort their multipart uploads after the commit (§11). A staged session has no parent yet and
 *  is reaped by the §11 GC sweeps instead. */
export async function dropUploadSessions(client: DbClient, subtree: Pick<Subtree, "challengeIds" | "solutionIds">): Promise<{ objectKey: string; s3UploadId: string }[]> {
  const { rows } = await client.query<{ object_key: string; s3_upload_id: string }>(
    `delete from attachment_uploads
      where (parent_type = 'challenge' and parent_id = any($1::uuid[])) or (parent_type = 'solution' and parent_id = any($2::uuid[]))
      returning object_key, s3_upload_id`,
    [subtree.challengeIds, subtree.solutionIds],
  );
  return rows.map((r) => ({ objectKey: r.object_key, s3UploadId: r.s3_upload_id }));
}

/**
 * §13.2: clears a challenge's Home pin, writing `challenge.unfeatured` with the given trigger — a
 * no-op when it is not featured. `deleted` runs inside the purge before the row goes; `trashed`
 * runs at trash time, and a restore never re-pins. Curation only: `updated_at` is left alone.
 */
export async function unpinChallenge(client: DbClient, actorUserId: string | null, challengeId: string, trigger: "deleted" | "trashed"): Promise<boolean> {
  const { rows } = await client.query<{ featured_at: Date | null }>(`select featured_at from challenges where id = $1 for update`, [challengeId]);
  const featuredAt = rows[0]?.featured_at ?? null;
  if (featuredAt === null) return false;
  await client.query(`update challenges set featured_at = null, featured_by = null where id = $1`, [challengeId]);
  await appendAudit(client, {
    actorUserId,
    action: "challenge.unfeatured",
    targetType: "challenge",
    targetId: challengeId,
    before: { featuredAt: featuredAt.toISOString() },
    after: { trigger },
  });
  return true;
}

/**
 * Delete every child row of the given challenge/solution ids (polymorphic children carry
 * `parent_type` + `parent_id` and no FK, so the cascade is explicit app SQL rather than
 * ON DELETE CASCADE). Returns the counts plus the object-store work to run post-commit.
 */
async function deleteChildren(
  client: DbClient,
  subtree: Subtree,
): Promise<{ counts: Omit<CascadeCounts, "solutions">; purge: ObjectPurge }> {
  const params = [subtree.challengeIds, subtree.solutionIds];
  const parentMatch = `((parent_type = 'challenge' and parent_id = any($1::uuid[])) or (parent_type = 'solution' and parent_id = any($2::uuid[])))`;

  const comments = await client.query(`delete from comments where ${parentMatch}`, params);
  const likes = await client.query(`delete from likes where ${parentMatch}`, params);
  const hypes = await client.query(`delete from hypes where ${parentMatch}`, params);
  const follows = await client.query(`delete from follows where ${parentMatch}`, params);

  // Tombstones go too (the §11 retention rule is carved out here, and only here); their MinIO
  // objects are purged after the commit — `infected` rows were already purged at scan time, and
  // DeleteObject on an absent key is a no-op, so one uniform purge is safe.
  const attachments = await client.query<{ object_key: string }>(`delete from attachments where ${parentMatch} returning object_key`, params);
  const sessions = await dropUploadSessions(client, subtree);

  // §12.4: every webhook delivery row targeting the subtree, sent or not (polymorphic, no FK).
  const webhookDeliveries = await client.query(
    `delete from webhook_deliveries where (entity_type = 'challenge' and entity_id = any($1::uuid[])) or (entity_type = 'solution' and entity_id = any($2::uuid[]))`,
    params,
  );

  // §22.7: cached AI output shares its item's lifecycle (polymorphic parent, no FK).
  const aiResults = await deleteAiResults(client, subtree.challengeIds, subtree.solutionIds);

  // §12.1: no inbox item may survive pointing at an entity that no longer exists; unsent e-mail
  // about it never goes out.
  const inbox = await client.query(`delete from notifications where ${SUBTREE_NOTIFICATION_MATCH}`, subtreeNotificationParams(subtree));
  const outbox = await client.query(
    `delete from notification_outbox where ${SUBTREE_NOTIFICATION_MATCH} and status <> 'sent'`,
    subtreeNotificationParams(subtree),
  );

  return {
    counts: {
      comments: comments.rowCount ?? 0,
      likes: likes.rowCount ?? 0,
      hypes: hypes.rowCount ?? 0,
      follows: follows.rowCount ?? 0,
      attachments: attachments.rowCount ?? 0,
      uploadSessions: sessions.length,
      webhookDeliveries: webhookDeliveries.rowCount ?? 0,
      aiResults,
      notifications: inbox.rowCount ?? 0,
      outbox: outbox.rowCount ?? 0,
    },
    purge: { objectKeys: attachments.rows.map((r) => r.object_key), sessions },
  };
}

/** Best-effort object-store cleanup after the DB transaction commits. A failure here leaves
 *  bytes that nothing can reach (the metadata row is gone), so it is logged, not thrown. */
export async function abortUploadSessions(storage: PurgeStorage, sessions: { objectKey: string; s3UploadId: string }[]): Promise<void> {
  for (const session of sessions) {
    await storage.abortMultipartUpload(session.objectKey, session.s3UploadId).catch((err) => {
      console.error(JSON.stringify({ level: "error", msg: "upload session abort failed", objectKey: session.objectKey, error: String(err) }));
    });
  }
}

async function runObjectPurge(storage: PurgeStorage, purge: ObjectPurge): Promise<void> {
  for (const key of purge.objectKeys) {
    await storage.deleteObject(key).catch((err) => {
      console.error(JSON.stringify({ level: "error", msg: "deleted attachment object purge failed", objectKey: key, error: String(err) }));
    });
  }
  await abortUploadSessions(storage, purge.sessions);
}

/** The audit fields every purge row carries beyond its metadata (§10.3 *Audit*). */
function purgeAuditAfter(request: PurgeRequest, counts: CascadeCounts, trashedAt: Date | null): Record<string, unknown> {
  return {
    reason: request.reason,
    trigger: request.trigger,
    ...(trashedAt ? { trashedAt: trashedAt.toISOString() } : {}),
    cascade: counts,
  };
}

/**
 * Permanently delete a challenge and everything under it — all of its solutions regardless of
 * status or trash state, and every comment, like, follow, attachment, notification, and unsent
 * outbox row on the challenge or those solutions (§10.3). `number` is the bare digits.
 */
export async function purgeChallenge(deps: { pool: DbPool; storage: PurgeStorage }, number: string, request: PurgeRequest): Promise<PurgeChallengeResult> {
  const { rows } = await deps.pool.query<{ id: string; number: string; status: string; author_id: string | null; namespace_id: string; public_submission_id: string | null }>(
    `select id, number::text, status, author_id, namespace_id, public_submission_id from challenges where number = $1`,
    [number],
  );
  const challenge = rows[0];
  if (!challenge) return { status: "not_found" };

  const outcome = await inTransaction(deps.pool, async (client) => {
    // Re-read under the row lock: a concurrent purge (the worker and an admin) must not run twice.
    const { rows: locked } = await client.query<{ trashed_at: Date | null }>(`select trashed_at from challenges where id = $1 for update`, [challenge.id]);
    if (!locked[0] || retentionStandsDown(request, locked[0].trashed_at)) return null;
    const { rows: solutionRows } = await client.query<{ id: string }>(`select id from solutions where challenge_id = $1`, [challenge.id]);
    const solutionIds = solutionRows.map((r) => r.id);

    // A challenge's link scope covers its own link plus every `#SOL-<n>` link beneath it.
    const children = await deleteChildren(client, {
      challengeIds: [challenge.id],
      solutionIds,
      linkScope: notificationLinkScope({ challengeNumber: challenge.number }),
    });

    // §13.2: a featured challenge's pin is closed out in the audit trail before the row goes.
    await unpinChallenge(client, request.actorUserId, challenge.id, "deleted");
    await client.query(`delete from solutions where challenge_id = $1`, [challenge.id]);
    await client.query(`delete from challenges where id = $1`, [challenge.id]);
    // §24.8: a purged external challenge takes its submission row — and any mail addressed to the
    // submitter, sent or not (a sent row would keep the address) — with it.
    if (challenge.public_submission_id) {
      await client.query(`delete from notification_outbox where recipient_email is not null and payload->>'submissionId' = $1`, [
        challenge.public_submission_id,
      ]);
      await client.query(`delete from public_submissions where id = $1`, [challenge.public_submission_id]);
    }

    const counts: CascadeCounts = { ...children.counts, solutions: solutionIds.length };
    await appendAudit(client, {
      actorUserId: request.actorUserId,
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
      after: purgeAuditAfter(request, counts, locked[0].trashed_at),
    });
    return { counts, purge: children.purge };
  });
  if (!outcome) return { status: "not_found" };

  await runObjectPurge(deps.storage, outcome.purge);
  return { status: "ok", counts: outcome.counts };
}

/**
 * Permanently delete one solution and its own children, leaving the parent challenge standing
 * (§10.3). When the purged solution was the `implemented` one of a `solved` challenge, the
 * challenge is un-solved back to `valid` in the same transaction — siblings closed as
 * `not_selected` stay closed, and the §8.3 single-winner slot is free again. `number` is the
 * bare digits.
 */
export async function purgeSolution(deps: { pool: DbPool; storage: PurgeStorage }, number: string, request: PurgeRequest): Promise<PurgeSolutionResult> {
  const { rows } = await deps.pool.query<{
    id: string;
    number: string;
    status: string;
    author_id: string;
    challenge_id: string;
    challenge_number: string;
    namespace_id: string;
  }>(
    `select s.id, s.number::text, s.status, s.author_id,
            c.id as challenge_id, c.number::text as challenge_number, c.namespace_id
       from solutions s
       join challenges c on c.id = s.challenge_id
      where s.number = $1`,
    [number],
  );
  const solution = rows[0];
  if (!solution) return { status: "not_found" };

  const outcome = await inTransaction(deps.pool, async (client) => {
    // Lock the parent first (the revert below writes it), then re-read the solution.
    const { rows: parentRows } = await client.query<{ status: string }>(`select status from challenges where id = $1 for update`, [solution.challenge_id]);
    const { rows: locked } = await client.query<{ trashed_at: Date | null }>(`select trashed_at from solutions where id = $1 for update`, [solution.id]);
    if (!locked[0] || !parentRows[0] || retentionStandsDown(request, locked[0].trashed_at)) return null;
    const challengeStatus = parentRows[0].status;
    const revertTo = parentStatusAfterSolutionDelete({
      solutionStatus: solution.status as SolutionStatus,
      challengeStatus: challengeStatus as ChallengeStatus,
    });

    const children = await deleteChildren(client, {
      challengeIds: [],
      solutionIds: [solution.id],
      linkScope: notificationLinkScope({ challengeNumber: solution.challenge_number, solutionNumber: solution.number }),
    });

    await client.query(`delete from solutions where id = $1`, [solution.id]);

    if (revertTo !== null) {
      // solved → valid keeps any Home pin (both are featurable, §13.2), so there is nothing to unpin.
      await client.query(`update challenges set status = $2, resolved_at = null, updated_at = now(), status_changed_at = now() where id = $1`, [
        solution.challenge_id,
        revertTo,
      ]);
      await appendAudit(client, {
        actorUserId: request.actorUserId,
        action: "challenge.status_changed",
        targetType: "challenge",
        targetId: solution.challenge_id,
        before: { status: challengeStatus },
        after: { status: revertTo, override: true, trigger: "solution_deleted" },
      });
    }

    const counts: CascadeCounts = { ...children.counts, solutions: 0 };
    await appendAudit(client, {
      actorUserId: request.actorUserId,
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
      after: purgeAuditAfter(request, counts, locked[0].trashed_at),
    });
    return { counts, purge: children.purge, reverted: revertTo !== null };
  });
  if (!outcome) return { status: "not_found" };

  await runObjectPurge(deps.storage, outcome.purge);
  return { status: "ok", counts: outcome.counts, challengeRevertedToValid: outcome.reverted };
}

// ── §10.4 automatic purge ────────────────────────────────────────────────────────────────

/** One trashed item whose 30 days are up, oldest first. */
export interface DueTrashItem {
  kind: "challenge" | "solution";
  number: string;
  reason: string;
  trashedAt: Date;
}

/** Every trashed item whose `trashed_at` is at least `retentionDays` old, oldest first. A
 *  solution under a challenge that is itself due is left out: purging the challenge takes it. */
export async function listDueTrash(db: DbClient, retentionDays: number): Promise<DueTrashItem[]> {
  const { rows } = await db.query<{ kind: "challenge" | "solution"; number: string; reason: string; trashed_at: Date }>(
    `select * from (
       select 'challenge' as kind, c.number::text as number, c.trash_reason as reason, c.trashed_at
         from challenges c
        where c.trashed_at is not null and c.trashed_at <= now() - make_interval(days => $1::int)
       union all
       select 'solution' as kind, s.number::text as number, s.trash_reason as reason, s.trashed_at
         from solutions s
         join challenges c on c.id = s.challenge_id
        where s.trashed_at is not null and s.trashed_at <= now() - make_interval(days => $1::int)
          and not (c.trashed_at is not null and c.trashed_at <= now() - make_interval(days => $1::int))
     ) due
     order by trashed_at asc`,
    [retentionDays],
  );
  return rows.map((r) => ({ kind: r.kind, number: r.number, reason: r.reason, trashedAt: r.trashed_at }));
}

// §10.4 trash & restore (INNOBOX_SPEC.md): the platform-admin safety net in front of the §10.3
// purge. Trashing flags the item's own row and nothing else — comments, likes, follows,
// attachments, assignments, inbox rows and gamification awards all stay where they are, hidden
// through the item by the shared visibility predicate (§4.3). Restore clears the flag and the item
// comes back exactly as it was: status, assignee, visibility and number untouched, no transition
// written, `updated_at` / `edited_at` not bumped, nobody notified.
//
// Platform admins only, for every action here — anyone else is answered `not_found` (404, never
// 403), checked first, so none of this is an existence oracle (invariant 2). The audit rows carry
// no content, like the delete's. Relative imports only (the gated dbtests run under plain node).
import type { Pool, PoolClient } from "pg";
import {
  daysInTrash,
  formatChallengeNumber,
  formatSolutionNumber,
  maskAuthor,
  notificationLinkScope,
  solutionRestoreBlocked,
  trashPurgesOn,
  escapeLike,
  type MaskedAuthor,
} from "@innobox/shared";
import { abortUploadSessions, dropUploadSessions, removeUnsentAbout, unpinChallenge, type PurgeStorage } from "@innobox/shared/item-delete";
import { appendAudit } from "../../../lib/audit";
import { inTransaction } from "../../../lib/db";
import type { Viewer } from "./store";

export interface TrashDeps {
  pool: Pool;
  storage: PurgeStorage;
}

export type TrashResult = { status: "ok" } | { status: "not_found" } | { status: "already_trashed" };

export type RestoreResult = { status: "ok" } | { status: "not_found" } | { status: "not_trashed" } | { status: "parent_trashed" };

/** Trash-time side effects shared by both item kinds (§10.4), inside the trash transaction:
 *  every unsent e-mail and channel post about the subtree is removed (not recreated on restore),
 *  and its in-flight chunked uploads are dropped — aborted in the object store after the commit. */
async function hideSubtree(
  client: PoolClient,
  subtree: { challengeIds: string[]; solutionIds: string[]; linkScope: { exact: string; prefix: string | null } },
): Promise<{ objectKey: string; s3UploadId: string }[]> {
  await removeUnsentAbout(client, subtree);
  return dropUploadSessions(client, subtree);
}

/**
 * Move a challenge to the trash. It and every solution under it drop out of every surface at
 * once. A featured challenge is unfeatured (`trigger: "trashed"`); a restore does not re-pin it.
 */
export async function trashChallenge(deps: TrashDeps, admin: Viewer, number: string, reason: string): Promise<TrashResult> {
  if (!admin.roles.isPlatformAdmin) return { status: "not_found" };
  const outcome = await inTransaction(deps.pool, async (client): Promise<TrashResult & { sessions?: { objectKey: string; s3UploadId: string }[] }> => {
    const { rows } = await client.query<{
      id: string;
      number: string;
      status: string;
      namespace_id: string;
      trashed_at: Date | null;
      public_submission_id: string | null;
    }>(
      `select id, number::text, status, namespace_id, trashed_at, public_submission_id from challenges where number = $1 for update`,
      [number],
    );
    const challenge = rows[0];
    if (!challenge) return { status: "not_found" };
    if (challenge.trashed_at !== null) return { status: "already_trashed" };

    await unpinChallenge(client, admin.userId, challenge.id, "trashed");
    // Curation, not content: updated_at / edited_at stay as they were.
    await client.query(`update challenges set trashed_at = now(), trashed_by = $2, trash_reason = $3 where id = $1`, [challenge.id, admin.userId, reason]);
    const { rows: solutionRows } = await client.query<{ id: string }>(`select id from solutions where challenge_id = $1`, [challenge.id]);
    const sessions = await hideSubtree(client, {
      challengeIds: [challenge.id],
      solutionIds: solutionRows.map((r) => r.id),
      linkScope: notificationLinkScope({ challengeNumber: challenge.number }),
    });
    // §24.7: a trashed external challenge sends its submitter nothing — mail still queued for them
    // is withdrawn (sent rows stay, until the §24.8 erasure or a purge removes them).
    if (challenge.public_submission_id) {
      await client.query(
        `delete from notification_outbox where recipient_email is not null and payload->>'submissionId' = $1 and status <> 'sent'`,
        [challenge.public_submission_id],
      );
    }
    await appendAudit(client, {
      actorUserId: admin.userId,
      action: "challenge.trashed",
      targetType: "challenge",
      targetId: challenge.id,
      after: { number: formatChallengeNumber(challenge.number), namespaceId: challenge.namespace_id, status: challenge.status, reason },
    });
    return { status: "ok", sessions };
  });
  if (outcome.status === "ok" && outcome.sessions) await abortUploadSessions(deps.storage, outcome.sessions);
  return { status: outcome.status } as TrashResult;
}

/**
 * Move one solution to the trash; its challenge stays. It keeps its status — an implemented
 * solution does not un-solve its challenge, and one past `valid` still holds the §8.3
 * single-winner slot — which is what makes every restore safe.
 */
export async function trashSolution(deps: TrashDeps, admin: Viewer, number: string, reason: string): Promise<TrashResult> {
  if (!admin.roles.isPlatformAdmin) return { status: "not_found" };
  const outcome = await inTransaction(deps.pool, async (client): Promise<TrashResult & { sessions?: { objectKey: string; s3UploadId: string }[] }> => {
    const { rows } = await client.query<{
      id: string;
      number: string;
      status: string;
      trashed_at: Date | null;
      challenge_number: string;
      challenge_trashed: boolean;
      namespace_id: string;
    }>(
      `select s.id, s.number::text, s.status, s.trashed_at, c.number::text as challenge_number,
              c.trashed_at is not null as challenge_trashed, c.namespace_id
         from solutions s join challenges c on c.id = s.challenge_id
        where s.number = $1
          for update of s`,
      [number],
    );
    const solution = rows[0];
    if (!solution) return { status: "not_found" };
    // Under a trashed challenge it is already in the trash, through its challenge.
    if (solution.trashed_at !== null || solution.challenge_trashed) return { status: "already_trashed" };

    await client.query(`update solutions set trashed_at = now(), trashed_by = $2, trash_reason = $3 where id = $1`, [solution.id, admin.userId, reason]);
    const sessions = await hideSubtree(client, {
      challengeIds: [],
      solutionIds: [solution.id],
      linkScope: notificationLinkScope({ challengeNumber: solution.challenge_number, solutionNumber: solution.number }),
    });
    await appendAudit(client, {
      actorUserId: admin.userId,
      action: "solution.trashed",
      targetType: "solution",
      targetId: solution.id,
      after: { number: formatSolutionNumber(solution.number), namespaceId: solution.namespace_id, status: solution.status, reason },
    });
    return { status: "ok", sessions };
  });
  if (outcome.status === "ok" && outcome.sessions) await abortUploadSessions(deps.storage, outcome.sessions);
  return { status: outcome.status } as TrashResult;
}

/** Bring a challenge back from the trash, with every solution that was not trashed on its own. */
export async function restoreChallenge(pool: Pool, admin: Viewer, number: string): Promise<RestoreResult> {
  if (!admin.roles.isPlatformAdmin) return { status: "not_found" };
  return inTransaction(pool, async (client): Promise<RestoreResult> => {
    const { rows } = await client.query<{ id: string; number: string; namespace_id: string; trashed_at: Date | null }>(
      `select id, number::text, namespace_id, trashed_at from challenges where number = $1 for update`,
      [number],
    );
    const challenge = rows[0];
    if (!challenge) return { status: "not_found" };
    if (challenge.trashed_at === null) return { status: "not_trashed" };
    await client.query(`update challenges set trashed_at = null, trashed_by = null, trash_reason = null where id = $1`, [challenge.id]);
    await appendAudit(client, {
      actorUserId: admin.userId,
      action: "challenge.restored",
      targetType: "challenge",
      targetId: challenge.id,
      after: { number: formatChallengeNumber(challenge.number), namespaceId: challenge.namespace_id, daysInTrash: daysInTrash(challenge.trashed_at, new Date()) },
    });
    return { status: "ok" };
  });
}

/** Bring one solution back. Refused while its challenge is still in the trash. */
export async function restoreSolution(pool: Pool, admin: Viewer, number: string): Promise<RestoreResult> {
  if (!admin.roles.isPlatformAdmin) return { status: "not_found" };
  return inTransaction(pool, async (client): Promise<RestoreResult> => {
    const { rows } = await client.query<{ id: string; number: string; namespace_id: string; trashed_at: Date | null; challenge_trashed: boolean }>(
      `select s.id, s.number::text, c.namespace_id, s.trashed_at, c.trashed_at is not null as challenge_trashed
         from solutions s join challenges c on c.id = s.challenge_id
        where s.number = $1
          for update of s`,
      [number],
    );
    const solution = rows[0];
    if (!solution) return { status: "not_found" };
    if (solution.trashed_at === null) return { status: "not_trashed" };
    if (solutionRestoreBlocked({ challengeTrashed: solution.challenge_trashed })) return { status: "parent_trashed" };
    await client.query(`update solutions set trashed_at = null, trashed_by = null, trash_reason = null where id = $1`, [solution.id]);
    await appendAudit(client, {
      actorUserId: admin.userId,
      action: "solution.restored",
      targetType: "solution",
      targetId: solution.id,
      after: { number: formatSolutionNumber(solution.number), namespaceId: solution.namespace_id, daysInTrash: daysInTrash(solution.trashed_at, new Date()) },
    });
    return { status: "ok" };
  });
}

// ── The trash page (/admin/trash) ────────────────────────────────────────────────────────

export interface TrashRow {
  type: "challenge" | "solution";
  number: string;
  /** The challenge's number — where the item's page is (a solution lives on its challenge's). */
  challengeNumber: string;
  /** The challenge's title; for a solution, the title of the challenge it answers. */
  title: string;
  namespaceSlug: string;
  /** Masked per §9 — the trash is not a reveal path. */
  author: MaskedAuthor;
  trashedBy: string;
  trashedAt: string;
  reason: string;
  purgesOn: string;
  /** A solution whose challenge is in the trash too: its Restore waits for the challenge's. */
  restoreBlocked: boolean;
}

/** At most this many rows are listed; the purge keeps the trash to 30 days of deletions. */
export const TRASH_LIST_LIMIT = 500;

/** Every trashed challenge and solution, newest first, optionally filtered by number or title. */
export async function listTrash(pool: Pool, admin: Viewer, query: string | null): Promise<TrashRow[] | null> {
  if (!admin.roles.isPlatformAdmin) return null;
  const q = (query ?? "").trim();
  // A number query matches that number (CH-12 only the challenge, SOL-12 only the solution, a bare
  // 12 either); any query also matches a title.
  const numberMatch = /^(CH-|SOL-)?(\d+)$/i.exec(q);
  const digits = numberMatch?.[2] ?? null;
  const numberType = numberMatch?.[1] ? (numberMatch[1].toUpperCase() === "CH-" ? "challenge" : "solution") : null;
  const { rows } = await pool.query<{
    type: "challenge" | "solution";
    number: string;
    challenge_number: string;
    title: string;
    namespace_slug: string;
    is_anonymous: boolean;
    author_id: string | null;
    author_display_name: string | null;
    author_active: boolean | null;
    author_scrubbed: boolean | null;
    external_company: string | null;
    trashed_by: string | null;
    trashed_at: Date;
    reason: string;
    restore_blocked: boolean;
  }>(
    `select * from (
       select 'challenge' as type, c.number::text as number, c.number::text as challenge_number, c.title, ns.slug as namespace_slug,
              c.is_anonymous, c.author_id, u.display_name as author_display_name, u.active as author_active,
              u.scrubbed_at is not null as author_scrubbed, ps.company as external_company, tu.display_name as trashed_by, c.trashed_at,
              c.trash_reason as reason, false as restore_blocked
         from challenges c
         -- §24.6: an external challenge has no author; the masked projection labels it instead.
         left join users u on u.id = c.author_id
         left join public_submissions ps on ps.id = c.public_submission_id
         join namespaces ns on ns.id = c.namespace_id
         left join users tu on tu.id = c.trashed_by
        where c.trashed_at is not null
       union all
       select 'solution' as type, s.number::text as number, c.number::text as challenge_number, c.title, ns.slug as namespace_slug,
              s.is_anonymous, s.author_id, u.display_name as author_display_name, u.active as author_active,
              u.scrubbed_at is not null as author_scrubbed, null as external_company, tu.display_name as trashed_by, s.trashed_at,
              s.trash_reason as reason, c.trashed_at is not null as restore_blocked
         from solutions s
         join challenges c on c.id = s.challenge_id
         join users u on u.id = s.author_id
         join namespaces ns on ns.id = c.namespace_id
         left join users tu on tu.id = s.trashed_by
        where s.trashed_at is not null
     ) t
     where ($1::text = ''
            or (t.number = $2::text and ($3::text is null or t.type = $3::text))
            or t.title ilike '%' || $4 || '%') -- §2.4: literal substring ($4 = escapeLike(q))
     order by t.trashed_at desc
     limit ${TRASH_LIST_LIMIT}`,
    [q, digits, numberType, escapeLike(q)],
  );
  return rows.map((r) => ({
    type: r.type,
    number: r.type === "challenge" ? formatChallengeNumber(r.number) : formatSolutionNumber(r.number),
    challengeNumber: formatChallengeNumber(r.challenge_number),
    title: r.title,
    namespaceSlug: r.namespace_slug,
    author: maskAuthor({
      isAnonymous: r.is_anonymous,
      authorId: r.author_id,
      authorDisplayName: r.author_display_name,
      authorActive: r.author_active,
      authorScrubbed: r.author_scrubbed,
      externalCompany: r.external_company,
    }),
    trashedBy: r.trashed_by ?? "",
    trashedAt: r.trashed_at.toISOString(),
    reason: r.reason,
    purgesOn: trashPurgesOn(r.trashed_at).toISOString(),
    restoreBlocked: r.restore_blocked,
  }));
}

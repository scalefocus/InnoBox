// The §12.1 e-mail digest job. A follower-type event's outbox row written for a recipient on a
// daily or weekly digest is HELD (digest_due_at = their next 06:00 UTC slot) and skipped by the
// per-event sweep. Once a recipient's held rows are due, this job sends them as ONE e-mail through
// the normal transport, wrapper and retry policy (./dispatch.ts), then marks them sent.
//
// Before rendering it drops a row when the recipient has already READ its inbox row (the digest
// is not a second copy), when the item is gone (its inbox row went with it, §10.3), or when the
// item is no longer visible to the recipient — the visibility check runs again at send time
// (invariant 2). Nothing left → no e-mail. With the e-mail switch off the held rows are discarded
// at the slot, as an immediate row would be. Dropped and discarded rows are marked sent, like the
// per-event sweep's opt-out skip, so they are never picked up again.
//
// The job runs on the notification sweep's cadence: a row is due from its slot onwards, so a
// worker that was down at 06:00 catches up, and a switch back to immediate delivery (which sets
// the held rows due now) is released as a single digest within one sweep.
import type { Pool } from "pg";
import {
  buildRoleSet,
  canSeeChallenge,
  type ChallengeVisibility,
  canSeeSolution,
  getEmailWrapperHtml,
  isEmailDelivery,
  renderDigest,
  type ChallengeStatus,
  type DigestFacts,
  type DigestUpdate,
  type Role,
  type RoleSet,
  type SolutionStatus,
} from "@innobox/shared";
import { deliverEmail, emailRetryDelaySeconds, MAX_EMAIL_ATTEMPTS, OUTBOX_DUE_SQL, renderEmailParts, type EmailTransportOptions } from "./dispatch.js";

export interface DigestSummary {
  /** Digest e-mails delivered. */
  sent: number;
  /** Held rows that went out inside a delivered digest. */
  rowsSent: number;
  /** Held rows left out because they were read, gone or no longer visible. */
  dropped: number;
  /** Held rows discarded because the recipient cannot receive e-mail (switch off, no address). */
  discarded: number;
  /** Digest e-mails that failed and were backed off for a retry. */
  failed: number;
}

/** One due held row with its inbox row (payload.notificationId), as the job reads it. */
export interface HeldRow {
  id: string;
  attempts: number;
  created_at: Date;
  payload: { parentType?: unknown; parentId?: unknown; digest?: DigestFacts; [key: string]: unknown };
  inbox_id: string | null;
  inbox_read_at: Date | null;
  inbox_at: Date | null;
  inbox_count: number | null;
}

export type DropReason = "malformed" | "gone" | "read" | "invisible";

/** Why a held row is left out of the digest, or null when it goes in. */
export function heldRowDropReason(row: HeldRow, visible: boolean): DropReason | null {
  if (!row.payload.digest) return "malformed";
  if (!row.inbox_id) return "gone";
  if (row.inbox_read_at) return "read";
  if (!visible) return "invisible";
  return null;
}

/** A kept row as a digest update. A coalesced comment row counts every comment its inbox row
 *  gathered, and is as recent as its latest one. */
export function toDigestUpdate(row: HeldRow): DigestUpdate {
  const facts = row.payload.digest!;
  const count = facts.kind === "comment" ? Math.max(1, row.inbox_count ?? 1) : 1;
  const at = row.inbox_at && row.inbox_at.getTime() > row.created_at.getTime() ? row.inbox_at : row.created_at;
  return { ...facts, count, at };
}

const MARK_SENT_SQL = `update notification_outbox set status = 'sent', sent_at = now() where id = any($1::uuid[])`;
const MARK_FAILED_MANY_SQL = `update notification_outbox
    set status = 'failed', attempts = attempts + 1, last_error = $2,
        next_attempt_at = now() + make_interval(secs => $3::int)
  where id = any($1::uuid[])`;

function log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, ...extra }));
}

/** A recipient's RoleSet, resolved the only way roles ever are (invariant 1): SCIM-synced group
 *  membership + role_mappings, plus the bootstrap group while it is configured — the worker twin
 *  of the web tier's resolveRolesForUser. */
async function resolveRoles(pool: Pool, userId: string, bootstrapAdminGroup: string | undefined): Promise<RoleSet> {
  const { rows: grants } = await pool.query<{ role: Role; namespace_id: string | null }>(
    `select rm.role, rm.namespace_id
       from group_members gm
       join groups g         on g.id = gm.group_id
       join role_mappings rm on rm.group_external_id = g.external_id
      where gm.user_id = $1`,
    [userId],
  );
  const { rows: bootstrap } = bootstrapAdminGroup
    ? await pool.query(
        `select 1 from group_members gm join groups g on g.id = gm.group_id where gm.user_id = $1 and g.external_id = $2`,
        [userId, bootstrapAdminGroup],
      )
    : { rows: [] };
  const { rows: global } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
  // §4.3 `people`: the challenges whose access list names the user.
  const { rows: access } = await pool.query<{ challenge_id: string }>(`select challenge_id from challenge_access where user_id = $1`, [userId]);
  return buildRoleSet(
    grants.map((g) => ({ role: g.role, namespaceId: g.namespace_id })),
    {
      bootstrapPlatformAdmin: bootstrap.length > 0,
      globalNamespaceId: global[0]?.id ?? "",
      accessListChallengeIds: access.map((r) => r.challenge_id),
    },
  );
}

/** The §4.3 gate for the row's item, with the item's CURRENT state. A vanished item is invisible,
 *  and so is a trashed one (§10.4) — to everyone, platform admins included: it sends nothing. */
async function isVisibleTo(pool: Pool, viewer: { userId: string; roles: RoleSet }, parentType: unknown, parentId: unknown): Promise<boolean> {
  if (typeof parentId !== "string" || (parentType !== "challenge" && parentType !== "solution")) return false;
  const { rows } = await pool.query<{
    challenge_id: string;
    namespace_id: string;
    visibility: ChallengeVisibility;
    challenge_status: ChallengeStatus;
    challenge_author_id: string;
    assignee_id: string | null;
    solution_status: SolutionStatus | null;
    solution_author_id: string | null;
    trashed: boolean;
  }>(
    parentType === "challenge"
      ? `select c.id as challenge_id, c.namespace_id, c.visibility, c.status as challenge_status, c.author_id as challenge_author_id, c.assignee_id,
                null as solution_status, null as solution_author_id, c.trashed_at is not null as trashed
           from challenges c where c.id = $1`
      : `select c.id as challenge_id, c.namespace_id, c.visibility, c.status as challenge_status, c.author_id as challenge_author_id, c.assignee_id,
                s.status as solution_status, s.author_id as solution_author_id,
                (s.trashed_at is not null or c.trashed_at is not null) as trashed
           from solutions s join challenges c on c.id = s.challenge_id where s.id = $1`,
    [parentId],
  );
  const row = rows[0];
  if (!row || row.trashed) return false;
  const challengeVisible = canSeeChallenge(viewer, {
    id: row.challenge_id,
    namespaceId: row.namespace_id,
    visibility: row.visibility,
    status: row.challenge_status,
    authorId: row.challenge_author_id,
    assigneeId: row.assignee_id,
    trashed: false,
  });
  if (!challengeVisible || parentType === "challenge") return challengeVisible;
  return canSeeSolution(
    viewer,
    { namespaceId: row.namespace_id, assigneeId: row.assignee_id },
    { status: row.solution_status!, authorId: row.solution_author_id!, trashed: false },
  );
}

/**
 * Sends every due digest: per recipient with held rows due, one e-mail of the rows that survive
 * the drop rules. A failed send backs the recipient's rows off exactly like a failed per-event
 * mail (emailRetryDelaySeconds, at most MAX_EMAIL_ATTEMPTS); a Graph 429 ends the run.
 */
export async function runDigestSweep(
  pool: Pool,
  opts: EmailTransportOptions & { bootstrapAdminGroup?: string; userBatch?: number },
): Promise<DigestSummary> {
  const summary: DigestSummary = { sent: 0, rowsSent: 0, dropped: 0, discarded: 0, failed: 0 };
  const { rows: due } = await pool.query<{ user_id: string }>(
    `select distinct o.user_id from notification_outbox o
      where o.digest_due_at <= now() and ${OUTBOX_DUE_SQL}
      limit $1`,
    [opts.userBatch ?? 50, MAX_EMAIL_ATTEMPTS],
  );
  if (due.length === 0) return summary;

  const wrapper = opts.graphEnv ? await getEmailWrapperHtml(pool) : null;

  for (const { user_id: userId } of due) {
    let keptIds: string[] = [];
    let attempts = 0;
    try {
      const { rows: held } = await pool.query<HeldRow>(
        `select o.id, o.attempts, o.created_at, o.payload,
                n.id as inbox_id, n.read_at as inbox_read_at, n.created_at as inbox_at,
                (n.payload->>'count')::int as inbox_count
           from notification_outbox o
           left join notifications n on n.id = (o.payload->>'notificationId')::uuid and n.user_id = o.user_id
          where o.user_id = $1 and o.digest_due_at <= now() and ${OUTBOX_DUE_SQL}
          order by o.created_at`,
        [userId, MAX_EMAIL_ATTEMPTS],
      );
      if (held.length === 0) continue;

      // §12.1: a deactivated or erased recipient's held rows are discarded at the slot.
      const { rows: users } = await pool.query<{ email: string | null; email_notifications_enabled: boolean; email_delivery: string; active: boolean }>(
        `select email, email_notifications_enabled, email_delivery, (active and scrubbed_at is null) as active from users where id = $1`,
        [userId],
      );
      const user = users[0];
      if (!user || !user.email || !user.email_notifications_enabled || !user.active) {
        await pool.query(MARK_SENT_SQL, [held.map((r) => r.id)]);
        summary.discarded += held.length;
        continue;
      }

      const viewer = { userId, roles: await resolveRoles(pool, userId, opts.bootstrapAdminGroup) };
      const kept: HeldRow[] = [];
      const dropped: string[] = [];
      for (const row of held) {
        const visible = row.payload.digest && row.inbox_id && !row.inbox_read_at ? await isVisibleTo(pool, viewer, row.payload.parentType, row.payload.parentId) : false;
        if (heldRowDropReason(row, visible) === null) kept.push(row);
        else dropped.push(row.id);
      }
      if (dropped.length > 0) {
        await pool.query(MARK_SENT_SQL, [dropped]);
        summary.dropped += dropped.length;
      }
      keptIds = kept.map((r) => r.id);
      attempts = Math.max(0, ...kept.map((r) => r.attempts));

      // The cadence word names the user's CURRENT choice; none after a switch back to immediate.
      const cadence = isEmailDelivery(user.email_delivery) && user.email_delivery !== "immediate" ? user.email_delivery : null;
      const digest = renderDigest(kept.map(toDigestUpdate), cadence, opts.baseUrl);
      if (!digest) continue;

      const { text, html } = renderEmailParts(digest.text, wrapper, opts.baseUrl);
      const outcome = await deliverEmail(pool, opts, wrapper, { to: user.email, subject: digest.subject.slice(0, 200), text, html });
      if (outcome.delivered) {
        await pool.query(MARK_SENT_SQL, [keptIds]);
        summary.sent += 1;
        summary.rowsSent += keptIds.length;
        continue;
      }
      await pool.query(MARK_FAILED_MANY_SQL, [
        keptIds,
        outcome.lastError ?? "no transport configured",
        emailRetryDelaySeconds(attempts, outcome.rateLimited ? outcome.retryAfterSeconds : undefined),
      ]);
      summary.failed += 1;
      if (outcome.rateLimited) {
        log("warn", "graph rate-limited (429) — stopping digest run, will resume next cycle", { userId, retryAfterSeconds: outcome.retryAfterSeconds });
        break;
      }
    } catch (err) {
      log("error", "digest for one recipient failed", { userId, error: String(err) });
      if (keptIds.length > 0) {
        await pool.query(MARK_FAILED_MANY_SQL, [keptIds, String((err as Error).message ?? err).slice(0, 500), emailRetryDelaySeconds(attempts)]).catch(() => {});
      }
      summary.failed += 1;
    }
  }
  return summary;
}

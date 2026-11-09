// Data layer for §41 "this affects me too" (INNOBOX_SPEC.md §41): setting and taking back the
// caller's mark (PUT/DELETE /api/challenges/:number/affected) and the per-viewer block on the
// challenge detail payload. The pure rules — the bounds, eligibility, the reach arithmetic — live in
// @innobox/shared (affected.ts); this module only reads and writes.
//
// Visibility (invariant 2): every read is scoped to a challenge the caller already proved the viewer
// can see (the detail decorator) or gated by the §4.3 check first (the writes, via
// loadInvitationChallenge). Anonymity (invariant 3): markers are real names by design; an author can
// never be among them, so the list names no anonymous author.
// Relative imports only (no `@/`) so the gated dbtests can load it.
import type { Pool, PoolClient } from "pg";
import { affectedReach, decideAffected, formatChallengeNumber, type AffectedReason, type ChallengeStatus } from "@innobox/shared";
import { appendAudit } from "../../../lib/audit";
import { inTransaction } from "../../../lib/db";
import { loadInvitationChallenge, type ChallengeDetail, type Viewer } from "./store";

type Db = Pool | PoolClient;

/** A colleague who said the challenge affects them — public by design (§41 decision 4). */
export interface AffectedPerson {
  id: string;
  displayName: string;
  headcount: number;
  deactivated: boolean;
  scrubbed: boolean;
}

/** The §41.10 block, on the detail payload and in both write responses. */
export interface AffectedBlock {
  reach: number;
  affectedPeople: number;
  affectedEstimate: number | null;
  /** The viewer's own current headcount, or null. */
  affectedMine: number | null;
  canMarkAffected: boolean;
  affectedReason: AffectedReason;
  /** Largest headcount first, then newest. */
  affected: AffectedPerson[];
}

/** The current marks of a challenge, in the §41.5 order. */
async function loadMarks(db: Db, challengeId: string): Promise<AffectedPerson[]> {
  const { rows } = await db.query<{ user_id: string; headcount: number; display_name: string; active: boolean; scrubbed: boolean }>(
    `select ca.user_id, ca.headcount, u.display_name, u.active, u.scrubbed_at is not null as scrubbed
       from challenge_affected ca join users u on u.id = ca.user_id
      where ca.challenge_id = $1 and ca.removed_at is null
      order by ca.headcount desc, ca.created_at desc, ca.id desc`,
    [challengeId],
  );
  return rows.map((r) => ({ id: r.user_id, displayName: r.display_name, headcount: r.headcount, deactivated: !r.active, scrubbed: r.scrubbed }));
}

/** The block for a challenge the viewer can already see. */
async function blockFor(
  db: Db,
  viewer: Viewer,
  challenge: { id: string; status: ChallengeStatus; isAuthor: boolean; trashed: boolean; estimate: number | null },
): Promise<AffectedBlock> {
  const marks = await loadMarks(db, challenge.id);
  const decision = decideAffected({ status: challenge.status, isAuthor: challenge.isAuthor, trashed: challenge.trashed });
  return {
    reach: affectedReach(
      challenge.estimate,
      marks.map((m) => m.headcount),
    ),
    affectedPeople: marks.length,
    affectedEstimate: challenge.estimate,
    affectedMine: marks.find((m) => m.id === viewer.userId)?.headcount ?? null,
    canMarkAffected: decision.canMark,
    affectedReason: decision.reason,
    affected: marks,
  };
}

/** §41.10: the block the GET detail route adds to a challenge the viewer is allowed to see. */
export async function affectedDetailFields(db: Db, viewer: Viewer, detail: ChallengeDetail): Promise<AffectedBlock> {
  return blockFor(db, viewer, {
    id: detail.id,
    status: detail.status,
    isAuthor: detail.isMine,
    trashed: Boolean(detail.trashed),
    estimate: detail.affectedEstimate,
  });
}

// ── Setting and taking back a mark ───────────────────────────────────────────────────────

export type AffectedWriteResult =
  | {
      status: "ok";
      block: AffectedBlock;
      /** This request created the person's first mark on the challenge — the auto-follow and
       *  event 24 follow it after commit (§41.3, §41.6). */
      first: boolean;
      challenge: { id: string; number: string; title: string };
    }
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "refused" };

/** The common gate: visible (404), not trashed (the shared 409), open and not the caller's own (the
 *  one 409). The challenge row is held FOR SHARE so a concurrent close cannot slip past it. */
async function lockMarkable(client: PoolClient, viewer: Viewer, number: string) {
  const challenge = await loadInvitationChallenge(client, viewer, number, true);
  if (!challenge) return { status: "not_found" } as const;
  if (challenge.trashed) return { status: "trashed" } as const;
  const isAuthor = challenge.authorIds.includes(viewer.userId);
  const decision = decideAffected({ status: challenge.visibility.status, isAuthor, trashed: false });
  if (!decision.canMark) return { status: "refused" } as const;
  return { status: "ok", challenge, isAuthor } as const;
}

/** The same gate without a write — the PUT route runs it before refusing a bad headcount, so the
 *  422 is only ever given about a challenge the caller could mark (§2.4 order of checks). */
export async function affectedGate(pool: Pool, viewer: Viewer, number: string): Promise<{ status: "ok" | "not_found" | "trashed" | "refused" }> {
  return inTransaction(pool, async (client) => ({ status: (await lockMarkable(client, viewer, number)).status }));
}

async function estimateOf(client: PoolClient, challengeId: string): Promise<number | null> {
  const { rows } = await client.query<{ affected_estimate: number | null }>(`select affected_estimate from challenges where id = $1`, [challengeId]);
  return rows[0]?.affected_estimate ?? null;
}

/**
 * PUT — creates or changes the caller's mark (§41.3). One row per person per challenge, ever: a
 * first mark inserts it, a re-mark after a removal clears `removed_at`, a change updates the
 * headcount. Audited `affected.marked` (a first mark or a re-mark) or `affected.changed`; saving the
 * same number again writes nothing. The unique key makes two concurrent first marks one row: the
 * loser updates the winner's row instead and is not `first`.
 */
export async function setAffected(pool: Pool, viewer: Viewer, number: string, headcount: number): Promise<AffectedWriteResult> {
  return inTransaction(pool, async (client): Promise<AffectedWriteResult> => {
    const gate = await lockMarkable(client, viewer, number);
    if (gate.status !== "ok") return gate;
    const { challenge } = gate;

    const inserted = await client.query(
      `insert into challenge_affected (challenge_id, user_id, headcount) values ($1, $2, $3)
       on conflict (challenge_id, user_id) do nothing returning id`,
      [challenge.id, viewer.userId, headcount],
    );
    const first = (inserted.rowCount ?? 0) > 0;
    if (first) {
      await appendAudit(client, { actorUserId: viewer.userId, action: "affected.marked", targetType: "challenge", targetId: challenge.id, after: { headcount } });
    } else {
      const { rows } = await client.query<{ headcount: number; removed: boolean }>(
        `select headcount, removed_at is not null as removed from challenge_affected where challenge_id = $1 and user_id = $2 for update`,
        [challenge.id, viewer.userId],
      );
      const prior = rows[0]!;
      if (prior.removed || prior.headcount !== headcount) {
        await client.query(`update challenge_affected set headcount = $3, removed_at = null, updated_at = now() where challenge_id = $1 and user_id = $2`, [
          challenge.id,
          viewer.userId,
          headcount,
        ]);
        await appendAudit(
          client,
          prior.removed
            ? { actorUserId: viewer.userId, action: "affected.marked", targetType: "challenge", targetId: challenge.id, after: { headcount } }
            : {
                actorUserId: viewer.userId,
                action: "affected.changed",
                targetType: "challenge",
                targetId: challenge.id,
                before: { headcount: prior.headcount },
                after: { headcount },
              },
        );
      }
    }

    const block = await blockFor(client, viewer, {
      id: challenge.id,
      status: challenge.visibility.status,
      isAuthor: false,
      trashed: false,
      estimate: await estimateOf(client, challenge.id),
    });
    return { status: "ok", block, first, challenge: { id: challenge.id, number: formatChallengeNumber(challenge.number), title: challenge.title } };
  });
}

/** DELETE — takes the caller's mark back (§41.3): the row stays with `removed_at` set, so a later
 *  re-mark is not a first mark. With no current mark it succeeds and writes nothing. */
export async function removeAffected(pool: Pool, viewer: Viewer, number: string): Promise<AffectedWriteResult> {
  return inTransaction(pool, async (client): Promise<AffectedWriteResult> => {
    const gate = await lockMarkable(client, viewer, number);
    if (gate.status !== "ok") return gate;
    const { challenge } = gate;

    const { rows } = await client.query<{ headcount: number }>(
      `update challenge_affected set removed_at = now(), updated_at = now()
        where challenge_id = $1 and user_id = $2 and removed_at is null
        returning headcount`,
      [challenge.id, viewer.userId],
    );
    if (rows[0]) {
      await appendAudit(client, {
        actorUserId: viewer.userId,
        action: "affected.removed",
        targetType: "challenge",
        targetId: challenge.id,
        before: { headcount: rows[0].headcount },
      });
    }
    const block = await blockFor(client, viewer, {
      id: challenge.id,
      status: challenge.visibility.status,
      isAuthor: false,
      trashed: false,
      estimate: await estimateOf(client, challenge.id),
    });
    return { status: "ok", block, first: false, challenge: { id: challenge.id, number: formatChallengeNumber(challenge.number), title: challenge.title } };
  });
}

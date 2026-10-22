// Data layer for topics (INNOBOX_SPEC.md §34): the per-viewer list behind `/topics`, the profile
// and the filtered gallery (§34.6), following (§34.4), an admin's re-tagging of a challenge on the
// detail page and in bulk (§34.3), and the platform admin's curation of the list (§34.2). Every
// count derived from items is the viewer's own (invariant 2); every write is audited except a
// follow, which is silent like an item follow. Imports stay relative (not @/) so the gated dbtest
// can run under the plain node test runner.
import type { Pool, PoolClient } from "pg";
import {
  ACTIVE_TOPICS_MAX,
  bulkTopicChange,
  canSeeChallenge,
  formatChallengeNumber,
  type BulkTopicOutcome,
  type ChallengeStatus,
  type ChallengeVisibility,
  type TopicRef,
  type TopicSetProblem,
} from "@innobox/shared";
import { appendAudit } from "../../../lib/audit";
import { inTransaction } from "../../../lib/db";
import { pushChallengeVisibilityConditions, type Viewer } from "../challenges/store";
import { isEntityNumber } from "../challenges/validation";
import { challengeTopicIds, checkChallengeTopics, writeChallengeTopics } from "./tagging";

// ── The list, per viewer (§34.6) ─────────────────────────────────────────────────────────

/** One topic as `/topics`, the profile and the filtered gallery show it. */
export interface TopicListItem {
  id: string;
  name: string;
  description: string | null;
  /** False only on the admins' `include=retired` list (§34.6 triage filter). */
  active: boolean;
  /** The viewer follows it. */
  following: boolean;
  /** The challenges carrying it that the viewer would see on the gallery's Open tab. */
  openCount: number;
}

/** The §13.1 Open tab's statuses — `/topics` counts what the filtered gallery would list there. */
const OPEN_STATUSES = `('in_review','needs_improvement','meeting_scheduled','valid')`;

/** Every active topic, alphabetical, with the viewer's follow state and open count — and, with
 *  `includeRetired` (the caller checks the viewer is an admin), the retired ones after them. The
 *  count runs the gallery's own visibility predicate, so it can never disagree with the filtered
 *  view. */
export async function listTopicsForViewer(pool: Pool, viewer: Viewer, opts: { includeRetired?: boolean } = {}): Promise<TopicListItem[]> {
  const params: unknown[] = [viewer.userId];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const conditions: string[] = [`ct.topic_id = t.id`, `c.status in ${OPEN_STATUSES}`];
  pushChallengeVisibilityConditions(viewer, push, conditions);
  const { rows } = await pool.query<{ id: string; name: string; description: string | null; active: boolean; following: boolean; open_count: number }>(
    `select t.id, t.name, t.description, t.active,
            exists (select 1 from topic_follows f where f.topic_id = t.id and f.user_id = $1) as following,
            (select count(*)::int from challenge_topics ct join challenges c on c.id = ct.challenge_id
              where ${conditions.join(" and ")}) as open_count
       from topics t
      where t.active or ${push(opts.includeRetired === true)}::boolean
      order by t.active desc, lower(t.name)`,
    params,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, active: r.active, following: r.following, openCount: r.open_count }));
}

/** The active topics, alphabetical, without per-viewer state — the §25.6 reference data and the
 *  §22.11 triage-assist vocabulary. */
export async function listActiveTopics(pool: Pool): Promise<{ id: string; name: string; description: string | null }[]> {
  const { rows } = await pool.query<{ id: string; name: string; description: string | null }>(
    `select id, name, description from topics where active order by lower(name)`,
  );
  return rows;
}

/** One topic for the filtered gallery's header (§34.6) — a retired one too, so its muted chip
 *  still leads somewhere. Null for an unknown id. */
export async function getTopicForViewer(
  pool: Pool,
  viewer: Viewer,
  id: string,
): Promise<{ id: string; name: string; description: string | null; active: boolean; following: boolean } | null> {
  const { rows } = await pool.query<{ id: string; name: string; description: string | null; active: boolean; following: boolean }>(
    `select t.id, t.name, t.description, t.active,
            exists (select 1 from topic_follows f where f.topic_id = t.id and f.user_id = $2) as following
       from topics t where t.id = $1`,
    [id, viewer.userId],
  );
  return rows[0] ?? null;
}

// ── Following (§34.4) ────────────────────────────────────────────────────────────────────

export type SetTopicFollowResult = { status: "ok"; following: boolean } | { status: "not_found" } | { status: "retired" };

/** Set the wanted state, so a repeated click is harmless. Any active topic can be followed; any
 *  topic, a retired one included, can be unfollowed. Silent: no audit, no notification. */
export async function setTopicFollow(pool: Pool, userId: string, topicId: string, following: boolean): Promise<SetTopicFollowResult> {
  const { rows } = await pool.query<{ active: boolean }>(`select active from topics where id = $1`, [topicId]);
  const topic = rows[0];
  if (!topic) return { status: "not_found" };
  if (following) {
    if (!topic.active) return { status: "retired" };
    await pool.query(`insert into topic_follows (user_id, topic_id) values ($1, $2) on conflict do nothing`, [userId, topicId]);
  } else {
    await pool.query(`delete from topic_follows where user_id = $1 and topic_id = $2`, [userId, topicId]);
  }
  return { status: "ok", following };
}

// ── An admin's re-tagging (§34.3) ────────────────────────────────────────────────────────

/** What a re-tag did — enough for the caller to fire event 18 for a challenge that is `valid`. */
export interface RetagOutcome {
  challengeId: string;
  /** The topics added (event 18's relevant topics while the challenge is `valid`). */
  addedTopicIds: string[];
  topics: TopicRef[];
}

export type SetChallengeTopicsResult =
  | ({ status: "ok" } & RetagOutcome)
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "forbidden" }
  | { status: "invalid_topics"; problem: TopicSetProblem };

interface RetagTarget {
  id: string;
  namespace_id: string;
  visibility: ChallengeVisibility;
  status: string;
  author_id: string | null;
  assignee_id: string | null;
  trashed: boolean;
}

/** The by-number gate every re-tag runs: an invisible challenge is "not found" (§2.4), a trashed
 *  one is read-only (§10.4), and only the challenge's namespace admins and platform admins may
 *  re-tag (committee members and the assignee may not). */
async function loadRetagTarget(pool: Pool, admin: Viewer, number: string): Promise<{ status: "ok"; row: RetagTarget } | { status: "not_found" | "trashed" | "forbidden" }> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<RetagTarget>(
    `select id, namespace_id, visibility, status, author_id, assignee_id, trashed_at is not null as trashed from challenges where number = $1`,
    [number],
  );
  const row = rows[0];
  const visible =
    row !== undefined &&
    canSeeChallenge(admin, {
      id: row.id,
      namespaceId: row.namespace_id,
      visibility: row.visibility,
      status: row.status as ChallengeStatus,
      authorId: row.author_id,
      assigneeId: row.assignee_id,
      trashed: row.trashed,
    });
  if (!row || !visible) return { status: "not_found" };
  if (row.trashed) return { status: "trashed" };
  if (!admin.roles.isNamespaceAdmin(row.namespace_id)) return { status: "forbidden" };
  return { status: "ok", row };
}

/** The challenge's topics as its payload carries them, alphabetical. */
async function challengeTopicRefs(db: Pool | PoolClient, challengeId: string): Promise<TopicRef[]> {
  const { rows } = await db.query<TopicRef>(
    `select t.id, t.name, t.active from challenge_topics ct join topics t on t.id = ct.topic_id where ct.challenge_id = $1 order by lower(t.name)`,
    [challengeId],
  );
  return rows;
}

/**
 * Re-tag one challenge: `compute` turns its current topics into the next set (or refuses), inside a
 * transaction that holds the challenge row, so two admins re-tagging at once cannot lose a change.
 * Curation, not a content edit: neither `updated_at` nor `edited_at` moves (§34.3). An unchanged
 * set writes nothing.
 */
async function retag(
  pool: Pool,
  admin: Viewer,
  number: string,
  via: "detail" | "bulk",
  compute: (current: string[]) => { next: string[] } | { refuse: TopicSetProblem } | { unchanged: true },
): Promise<SetChallengeTopicsResult | { status: "unchanged"; challengeId: string } | { status: "topic_limit" }> {
  const target = await loadRetagTarget(pool, admin, number);
  if (target.status !== "ok") return target;
  return inTransaction(pool, async (client) => {
    await client.query(`select 1 from challenges where id = $1 for update`, [target.row.id]);
    const current = await challengeTopicIds(client, target.row.id);
    const decided = compute(current);
    if ("unchanged" in decided) return { status: "unchanged" as const, challengeId: target.row.id };
    if ("refuse" in decided) return decided.refuse === "too_many" && via === "bulk" ? { status: "topic_limit" as const } : { status: "invalid_topics" as const, problem: decided.refuse };
    const check = await checkChallengeTopics(client, decided.next, current);
    if (check.problem) return { status: "invalid_topics" as const, problem: check.problem };
    const change = await writeChallengeTopics(client, target.row.id, current, decided.next, check.topics, admin.userId);
    if (change.added.length + change.removed.length > 0) {
      await appendAudit(client, {
        actorUserId: admin.userId,
        action: "challenge.topics_changed",
        targetType: "challenge",
        targetId: target.row.id,
        after: { added: change.added, removed: change.removed, via },
      });
    }
    return {
      status: "ok" as const,
      challengeId: target.row.id,
      addedTopicIds: change.added.map((t) => t.id),
      topics: await challengeTopicRefs(client, target.row.id),
    };
  });
}

/** `PUT /api/challenges/:number/topics` — replace a challenge's topics (§34.3). */
export async function setChallengeTopics(pool: Pool, admin: Viewer, number: string, topicIds: string[]): Promise<SetChallengeTopicsResult> {
  const result = await retag(pool, admin, number, "detail", () => ({ next: topicIds }));
  if (result.status === "unchanged") return { status: "ok", challengeId: result.challengeId, addedTopicIds: [], topics: await challengeTopicRefs(pool, result.challengeId) };
  if (result.status === "topic_limit") return { status: "invalid_topics", problem: "too_many" };
  return result;
}

/** One challenge's outcome in a §14.1 bulk *Add topic* / *Remove topic*. */
export interface BulkTopicItemOutcome {
  number: string;
  status: BulkTopicOutcome | "not_found" | "forbidden";
}

/** Bulk *Add topic* / *Remove topic* over a selection (§34.6): one transaction and one audit row
 *  per changed challenge (`via: "bulk"`); `onAdded` fires event 18 for each challenge a topic was
 *  added to, exactly as the single-item control does. The topic was checked by the caller. */
export async function bulkChangeTopic(
  pool: Pool,
  admin: Viewer,
  numbers: string[],
  action: "add" | "remove",
  topicId: string,
  onAdded: (challengeId: string, addedTopicIds: string[]) => Promise<void>,
): Promise<BulkTopicItemOutcome[]> {
  const outcomes: BulkTopicItemOutcome[] = [];
  for (const number of numbers) {
    const result = await retag(pool, admin, number, "bulk", (current) => {
      const change = bulkTopicChange(current, action, topicId);
      if (change.outcome === "unchanged") return { unchanged: true };
      if (change.outcome === "topic_limit") return { refuse: "too_many" };
      return { next: change.next };
    });
    let status: BulkTopicItemOutcome["status"];
    if (result.status === "ok") {
      status = "ok";
      if (result.addedTopicIds.length > 0) await onAdded(result.challengeId, result.addedTopicIds);
    } else if (result.status === "unchanged" || result.status === "topic_limit" || result.status === "forbidden" || result.status === "not_found") {
      status = result.status;
    } else if (result.status === "trashed") {
      status = "not_found"; // §10.4: a trashed challenge is not on the queue
    } else {
      status = result.problem === "too_many" ? "topic_limit" : "unchanged";
    }
    outcomes.push({ number: formatChallengeNumber(number), status });
  }
  return outcomes;
}

// ── Curation (§34.2, platform admin) ─────────────────────────────────────────────────────

/** One row of the Topics card. */
export interface AdminTopicItem {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  /** Every challenge carrying it — the card is platform-admin only, who see every challenge. */
  challengeCount: number;
  /** A bare count: no surface names who follows a topic (§34.4). */
  followerCount: number;
}

const ADMIN_TOPIC_SELECT = `
  select t.id, t.name, t.description, t.active,
         (select count(*)::int from challenge_topics ct where ct.topic_id = t.id) as "challengeCount",
         (select count(*)::int from topic_follows f where f.topic_id = t.id) as "followerCount"
    from topics t`;

/** Active topics first, each group alphabetical. */
export async function listAllTopics(pool: Pool): Promise<AdminTopicItem[]> {
  const { rows } = await pool.query<AdminTopicItem>(`${ADMIN_TOPIC_SELECT} order by t.active desc, lower(t.name)`);
  return rows;
}

async function adminTopic(pool: Pool | PoolClient, id: string): Promise<AdminTopicItem | null> {
  const { rows } = await pool.query<AdminTopicItem>(`${ADMIN_TOPIC_SELECT} where t.id = $1`, [id]);
  return rows[0] ?? null;
}

async function activeTopicCount(db: Pool | PoolClient): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from topics where active`);
  return rows[0]?.n ?? 0;
}

export type CreateTopicResult = { status: "ok"; topic: AdminTopicItem } | { status: "duplicate" } | { status: "cap" };

export async function createTopic(pool: Pool, input: { name: string; description: string | null }, actorUserId: string): Promise<CreateTopicResult> {
  return inTransaction(pool, async (client) => {
    // Serialize adds and reactivations so the 100-active cap cannot be overrun by a race.
    await client.query(`select pg_advisory_xact_lock(hashtext('innobox.topics.cap'))`);
    if ((await activeTopicCount(client)) >= ACTIVE_TOPICS_MAX) return { status: "cap" as const };
    const { rows } = await client.query<{ id: string }>(
      `insert into topics (name, description, created_by) values ($1, $2, $3) on conflict do nothing returning id`,
      [input.name, input.description, actorUserId],
    );
    const id = rows[0]?.id;
    if (!id) return { status: "duplicate" as const };
    await appendAudit(client, {
      actorUserId,
      action: "topic.created",
      targetType: "topic",
      targetId: id,
      after: { name: input.name, description: input.description },
    });
    return { status: "ok" as const, topic: (await adminTopic(client, id))! };
  });
}

export type PatchTopicResult = { status: "ok"; topic: AdminTopicItem } | { status: "not_found" } | { status: "duplicate" } | { status: "cap" };

/** Edit the name and description, and retire or reactivate (§34.2). Each kind of change is its own
 *  audit row; reactivating counts toward the cap and sends nothing (it is not an opening, §34.5). */
export async function patchTopic(
  pool: Pool,
  id: string,
  patch: { name?: string; description?: string | null; active?: boolean },
  actorUserId: string,
): Promise<PatchTopicResult> {
  return inTransaction(pool, async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('innobox.topics.cap'))`);
    const { rows } = await client.query<{ id: string; name: string; description: string | null; active: boolean }>(
      `select id, name, description, active from topics where id = $1 for update`,
      [id],
    );
    const row = rows[0];
    if (!row) return { status: "not_found" as const };

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (patch.name !== undefined && patch.name !== row.name) {
      const { rows: clash } = await client.query(`select 1 from topics where lower(name) = lower($1) and id <> $2`, [patch.name, id]);
      if (clash.length > 0) return { status: "duplicate" as const };
      before.name = row.name;
      after.name = patch.name;
    }
    if (patch.description !== undefined && patch.description !== row.description) {
      before.description = row.description;
      after.description = patch.description;
    }
    if (Object.keys(after).length > 0) {
      await client.query(`update topics set name = $2, description = $3 where id = $1`, [
        id,
        "name" in after ? after.name : row.name,
        "description" in after ? after.description : row.description,
      ]);
      await appendAudit(client, { actorUserId, action: "topic.updated", targetType: "topic", targetId: id, before, after });
    }

    if (patch.active !== undefined && patch.active !== row.active) {
      if (patch.active && (await activeTopicCount(client)) >= ACTIVE_TOPICS_MAX) return { status: "cap" as const };
      await client.query(`update topics set active = $2 where id = $1`, [id, patch.active]);
      await appendAudit(client, {
        actorUserId,
        action: patch.active ? "topic.reactivated" : "topic.retired",
        targetType: "topic",
        targetId: id,
        before: { active: row.active },
        after: { active: patch.active },
      });
    }
    return { status: "ok" as const, topic: (await adminTopic(client, id))! };
  });
}

export type DeleteTopicResult = { status: "ok"; challengeCount: number; followerCount: number } | { status: "not_found" } | { status: "not_retired" };

/** Delete a RETIRED topic (§34.2), in one transaction: its tags (one `challenge.topics_changed` row
 *  per challenge that loses it), its follows and the row. Nothing is reassigned — topics are
 *  optional — and nothing is notified. */
export async function deleteTopic(pool: Pool, id: string, actorUserId: string): Promise<DeleteTopicResult> {
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ name: string; description: string | null; active: boolean }>(
      `select name, description, active from topics where id = $1 for update`,
      [id],
    );
    const topic = rows[0];
    if (!topic) return { status: "not_found" as const };
    if (topic.active) return { status: "not_retired" as const };

    const { rows: untagged } = await client.query<{ challenge_id: string }>(`delete from challenge_topics where topic_id = $1 returning challenge_id`, [id]);
    for (const { challenge_id } of untagged) {
      await appendAudit(client, {
        actorUserId,
        action: "challenge.topics_changed",
        targetType: "challenge",
        targetId: challenge_id,
        after: { added: [], removed: [{ id, name: topic.name }], trigger: "topic_deleted" },
      });
    }
    const follows = await client.query(`delete from topic_follows where topic_id = $1`, [id]);
    await client.query(`delete from topics where id = $1`, [id]);
    const followerCount = follows.rowCount ?? 0;
    await appendAudit(client, {
      actorUserId,
      action: "topic.deleted",
      targetType: "topic",
      targetId: id,
      before: { name: topic.name, description: topic.description, active: topic.active },
      after: { challengeCount: untagged.length, followerCount },
    });
    return { status: "ok" as const, challengeCount: untagged.length, followerCount };
  });
}

// The database half of putting topics on a challenge (INNOBOX_SPEC.md §34.3): reading a
// challenge's topics, checking a proposed set against the §34.3 rules and writing the difference.
// Shared by the author's submit and edit (challenges/store.ts) and the admin's curation
// (./store.ts). Authorization and auditing are the caller's: nothing here checks who is asking.
// Imports stay relative (not @/) so the gated dbtests run under the plain node test runner.
import type { Pool, PoolClient } from "pg";
import { checkTopicSet, topicDiff, type TopicSetProblem } from "@innobox/shared";

type Db = Pool | PoolClient;

/** One topic as the tagging rules need it. */
export interface TopicRow {
  id: string;
  name: string;
  active: boolean;
}

/** The topic ids on a challenge, in no particular order. */
export async function challengeTopicIds(db: Db, challengeId: string): Promise<string[]> {
  const { rows } = await db.query<{ topic_id: string }>(`select topic_id from challenge_topics where challenge_id = $1`, [challengeId]);
  return rows.map((r) => r.topic_id);
}

/** The topics with these ids, by id (an unknown id is simply absent). */
export async function loadTopics(db: Db, ids: readonly string[]): Promise<Map<string, TopicRow>> {
  if (ids.length === 0) return new Map();
  const { rows } = await db.query<TopicRow>(`select id, name, active from topics where id = any($1::uuid[])`, [ids]);
  return new Map(rows.map((r) => [r.id, r]));
}

/** §34.3: is `next` an acceptable set for a challenge that carries `current`? */
export async function checkChallengeTopics(db: Db, next: readonly string[], current: readonly string[]): Promise<{ problem: TopicSetProblem | null; topics: Map<string, TopicRow> }> {
  const topics = await loadTopics(db, [...new Set([...next, ...current])]);
  return { problem: checkTopicSet(next, current, topics), topics };
}

/** Write the difference between a challenge's `current` topics and `next` (already checked).
 *  Returns what changed, as the audit names it: `{ id, name }` per topic. */
export async function writeChallengeTopics(
  client: PoolClient,
  challengeId: string,
  current: readonly string[],
  next: readonly string[],
  topics: ReadonlyMap<string, TopicRow>,
  actorUserId: string,
): Promise<{ added: { id: string; name: string }[]; removed: { id: string; name: string }[] }> {
  const { added, removed } = topicDiff(current, next);
  if (removed.length > 0) {
    await client.query(`delete from challenge_topics where challenge_id = $1 and topic_id = any($2::uuid[])`, [challengeId, removed]);
  }
  if (added.length > 0) {
    await client.query(
      `insert into challenge_topics (challenge_id, topic_id, added_by)
       select $1, t, $3 from unnest($2::uuid[]) as t
       on conflict do nothing`,
      [challengeId, added, actorUserId],
    );
  }
  const named = (id: string) => ({ id, name: topics.get(id)?.name ?? "" });
  return { added: added.map(named), removed: removed.map(named) };
}

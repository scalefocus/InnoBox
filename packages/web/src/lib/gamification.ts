// The web tier's §23 award hooks (INNOBOX_SPEC.md §23.2, §23.8): each builds the awards one
// triggering action earns and writes them through the shared writer INSIDE the caller's
// transaction — the create, the status transition (incl. the §8.3 auto-close), the like, the
// comment, the self-reveal. Call them AFTER the action's own audit row, so every transaction takes
// the audit chain's lock before the per-recipient award lock (one lock order, no deadlock).
//
// Anonymity (invariant 3, §23.2): while a challenge or solution is anonymous none of its
// item-bound awards are written for its author; a self-reveal replays them. Comments are never
// anonymous and the assignee never is, so those always award.
// Relative imports only (no `@/`) so the gated dbtests can load the stores that call this.
import type { PoolClient } from "pg";
import {
  awardKey,
  challengeAwardsSoFar,
  solutionAwardsSoFar,
  writeAwards,
  type AwardInput,
  type AwardItemType,
} from "@innobox/shared";

/** Live triggers notify (§12.1 event 13); only the worker backfill is silent. */
async function write(client: PoolClient, awards: AwardInput[]): Promise<void> {
  if (awards.length === 0) return;
  await writeAwards(client, awards, { notify: true });
}

/** `challenge_submitted` for a new, named challenge. */
export async function awardChallengeCreated(client: PoolClient, challenge: { id: string; authorId: string; isAnonymous: boolean }): Promise<void> {
  if (challenge.isAnonymous) return;
  await write(client, [
    { userId: challenge.authorId, reason: "challenge_submitted", itemType: "challenge", itemId: challenge.id, awardKey: awardKey.challengeSubmitted(challenge.id) },
  ]);
}

/** `solution_proposed` for a new, named solution. */
export async function awardSolutionCreated(client: PoolClient, solution: { id: string; authorId: string; isAnonymous: boolean }): Promise<void> {
  if (solution.isAnonymous) return;
  await write(client, [
    { userId: solution.authorId, reason: "solution_proposed", itemType: "solution", itemId: solution.id, awardKey: awardKey.solutionProposed(solution.id) },
  ]);
}

/** The awards a challenge earns on entering `status` — `valid` (author) or `solved` (author, and
 *  the assignee at that moment when they are not also the author). Who moved it doesn't matter. */
export async function challengeStatusAwards(client: PoolClient, challengeId: string, status: string): Promise<AwardInput[]> {
  if (status !== "valid" && status !== "solved") return [];
  // §26.7: every hyper of a challenge reaching `solved` earns its Talent Scout marker — the
  // enforced move, an override, a bulk set and the §8.3 auto-close all come through here.
  const hypers = status === "solved" ? await hypeFulfilledAwards(client, "challenge", challengeId) : [];
  const { rows } = await client.query<{ author_id: string | null; is_anonymous: boolean; assignee_id: string | null }>(
    `select author_id, is_anonymous, assignee_id from challenges where id = $1`,
    [challengeId],
  );
  const c = rows[0];
  if (!c) return [];
  const item = { itemType: "challenge" as const, itemId: challengeId };
  const out: AwardInput[] = [];
  // §24.6: an external challenge has no author to credit — only its assignee can earn on it.
  const author = c.is_anonymous ? null : c.author_id;
  if (status === "valid") {
    if (author) out.push({ ...item, userId: author, reason: "challenge_validated", awardKey: awardKey.challengeValidated(challengeId) });
    return out;
  }
  if (author) out.push({ ...item, userId: author, reason: "challenge_solved", awardKey: awardKey.challengeSolved(challengeId) });
  if (c.assignee_id && c.assignee_id !== c.author_id) {
    out.push({ ...item, userId: c.assignee_id, reason: "assignment_solved", awardKey: awardKey.assignmentSolved(challengeId) });
  }
  out.push(...hypers);
  return out;
}

/** The awards a solution's author earns on entering `valid` or `implemented`. */
export async function solutionStatusAwards(client: PoolClient, solutionId: string, status: string): Promise<AwardInput[]> {
  if (status !== "valid" && status !== "implemented") return [];
  // §26.7: the hypers' Talent Scout markers do not depend on the author's anonymity — the award
  // goes to the hyper, whose hype is public, and names no item anywhere.
  const hypers = status === "implemented" ? await hypeFulfilledAwards(client, "solution", solutionId) : [];
  const { rows } = await client.query<{ author_id: string; is_anonymous: boolean }>(`select author_id, is_anonymous from solutions where id = $1`, [solutionId]);
  const s = rows[0];
  if (!s || s.is_anonymous) return hypers;
  const item = { itemType: "solution" as const, itemId: solutionId, userId: s.author_id };
  return status === "valid"
    ? [{ ...item, reason: "solution_validated", awardKey: awardKey.solutionValidated(solutionId) }]
    : [{ ...item, reason: "solution_implemented", awardKey: awardKey.solutionImplemented(solutionId) }, ...hypers];
}

/** §26.7 `hype_fulfilled` — 0 points, one per (item, hyper), for every person who hyped an item
 *  that has just first reached `solved` (a challenge) or `implemented` (a solution). The award key
 *  keeps it once per item; nothing ever revokes it. */
export async function hypeFulfilledAwards(client: PoolClient, parentType: AwardItemType, parentId: string): Promise<AwardInput[]> {
  const { rows } = await client.query<{ user_id: string }>(`select user_id from hypes where parent_type = $1 and parent_id = $2`, [parentType, parentId]);
  return rows.map((h) => ({
    userId: h.user_id,
    reason: "hype_fulfilled" as const,
    itemType: parentType,
    itemId: parentId,
    awardKey: awardKey.hypeFulfilled(parentType, parentId, h.user_id),
  }));
}

/** §26.7 `hype_received` for the hyped item's author — 3 points, the first 10 a UTC day. Never
 *  while the item is anonymous (a self-reveal replays it); self-hype is refused before this. */
export async function awardHypeReceived(client: PoolClient, parentType: AwardItemType, parentId: string, hyperId: string): Promise<void> {
  const { rows } = await client.query<{ author_id: string | null; is_anonymous: boolean }>(
    parentType === "challenge"
      ? `select author_id, is_anonymous from challenges where id = $1`
      : `select author_id, is_anonymous from solutions where id = $1`,
    [parentId],
  );
  const item = rows[0];
  // An external challenge (§24.6) has no author to credit.
  if (!item || item.is_anonymous || item.author_id === null || item.author_id === hyperId) return;
  await write(client, [
    { userId: item.author_id, reason: "hype_received", itemType: parentType, itemId: parentId, awardKey: awardKey.hypeReceived(parentType, parentId, hyperId) },
  ]);
}

/** Writes a batch the caller gathered (a challenge transition, or the §8.3 auto-close's three
 *  awards together) — one call, so one event 13 inbox row per transaction. */
export async function writeLiveAwards(client: PoolClient, awards: AwardInput[]): Promise<void> {
  await write(client, awards);
}

/** `like_received` for the liked item's author — never for liking your own item, never while the
 *  item is anonymous. Unliking deducts nothing, and a re-like reuses the same key. */
export async function awardLikeReceived(client: PoolClient, parentType: AwardItemType, parentId: string, likerId: string): Promise<void> {
  const { rows } = await client.query<{ author_id: string | null; is_anonymous: boolean }>(
    parentType === "challenge"
      ? `select author_id, is_anonymous from challenges where id = $1`
      : `select author_id, is_anonymous from solutions where id = $1`,
    [parentId],
  );
  const item = rows[0];
  // An external challenge (§24.6) has no author to credit.
  if (!item || item.is_anonymous || item.author_id === null || item.author_id === likerId) return;
  await write(client, [
    {
      userId: item.author_id,
      reason: "like_received",
      itemType: parentType,
      itemId: parentId,
      awardKey: awardKey.likeReceived(parentType, parentId, likerId),
    },
  ]);
}

/** `comment_posted` for the commenter — comments are never anonymous (§9). `viaMcp` describes the
 *  comment itself (§25.12), not the item it was posted on. */
export async function awardCommentPosted(
  client: PoolClient,
  comment: { id: string; authorId: string; parentType: AwardItemType; parentId: string; viaMcp?: boolean },
): Promise<void> {
  await write(client, [
    {
      userId: comment.authorId,
      reason: "comment_posted",
      itemType: comment.parentType,
      itemId: comment.parentId,
      awardKey: awardKey.commentPosted(comment.id),
      viaMcp: comment.viaMcp ?? false,
    },
  ]);
}

/** §25.12 `agent_connected` — 0 points, once per person ever (the award key), the first time they
 *  approve an AI agent connection; it is what earns Plugged In. */
export async function awardAgentConnected(client: PoolClient, userId: string): Promise<void> {
  await write(client, [{ userId, reason: "agent_connected", itemType: null, itemId: null, awardKey: awardKey.agentConnected(), viaMcp: true }]);
}

/** §9 self-reveal: replays every award the item already earned for its author, backdated to the
 *  original event times — written only now, in the reveal's transaction. */
export async function replayOnSelfReveal(client: PoolClient, itemType: AwardItemType, itemId: string): Promise<void> {
  const awards =
    itemType === "challenge" ? await challengeAwardsSoFar(client, itemId, { author: true, assignee: false }) : await solutionAwardsSoFar(client, itemId);
  await write(client, awards);
}

// The web tier's §23 award hooks (INNOBOX_SPEC.md §23.2, §23.8): each builds the awards one
// triggering action earns and writes them through the shared writer INSIDE the caller's
// transaction — the create, the status transition (incl. the §8.3 auto-close), the like, the
// comment, the self-reveal, a team join. Call them AFTER the action's own audit row, so every
// transaction takes the audit chain's lock before the per-recipient award lock (one lock order, no
// deadlock).
//
// Anonymity (invariant 3, §23.2): while a challenge or solution is anonymous none of its
// item-bound awards are written for its author; a self-reveal replays them. Comments are never
// anonymous and the assignee never is, so those always award.
//
// Co-authors (§39.9): every award that goes to "the author" goes to each member of the item's team
// in full, under the same award key; "someone other than the author" means someone outside the team.
// Relative imports only (no `@/`) so the gated dbtests can load the stores that call this.
import type { PoolClient } from "pg";
import {
  awardKey,
  challengeAwardsSoFar,
  joinReplayAwards,
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

/** The item's current members (§39.2) — none for a challenge accepted from the public form. */
async function teamOf(client: PoolClient, itemType: AwardItemType, itemId: string): Promise<string[]> {
  const { rows } = await client.query<{ user_id: string }>(
    itemType === "challenge"
      ? `select user_id from challenge_authors where challenge_id = $1 order by added_at, user_id`
      : `select user_id from solution_authors where solution_id = $1 order by added_at, user_id`,
    [itemId],
  );
  return rows.map((r) => r.user_id);
}

/** The item's anonymity and team in one read. Null when it does not exist. */
async function namedTeam(client: PoolClient, itemType: AwardItemType, itemId: string): Promise<string[] | null> {
  const { rows } = await client.query<{ is_anonymous: boolean }>(
    itemType === "challenge" ? `select is_anonymous from challenges where id = $1` : `select is_anonymous from solutions where id = $1`,
    [itemId],
  );
  if (!rows[0]) return null;
  return rows[0].is_anonymous ? [] : teamOf(client, itemType, itemId);
}

/** `challenge_submitted` / `solution_proposed` for every member of a new, named item (§39.9). */
export async function awardItemCreated(client: PoolClient, itemType: AwardItemType, item: { id: string; authorIds: readonly string[]; isAnonymous: boolean }): Promise<void> {
  if (item.isAnonymous) return;
  await write(
    client,
    item.authorIds.map((userId) =>
      itemType === "challenge"
        ? { userId, reason: "challenge_submitted" as const, itemType, itemId: item.id, awardKey: awardKey.challengeSubmitted(item.id) }
        : { userId, reason: "solution_proposed" as const, itemType, itemId: item.id, awardKey: awardKey.solutionProposed(item.id) },
    ),
  );
}

/** §39.9: a member who joins now gets the milestones the item already reached, dated to the join. */
export async function writeJoinAwards(client: PoolClient, itemType: AwardItemType, itemId: string, userId: string, joinedAt: Date): Promise<void> {
  await write(client, await joinReplayAwards(client, itemType, itemId, userId, joinedAt));
}

/** The awards a challenge earns on entering `status` — `valid` (every member) or `solved` (every
 *  member, and the assignee at that moment when they are not a member, §39.9). Who moved it doesn't
 *  matter. */
export async function challengeStatusAwards(client: PoolClient, challengeId: string, status: string): Promise<AwardInput[]> {
  if (status !== "valid" && status !== "solved") return [];
  // §26.7: every hyper of a challenge reaching `solved` earns its Talent Scout marker — the
  // enforced move, an override, a bulk set and the §8.3 auto-close all come through here.
  const hypers = status === "solved" ? await hypeFulfilledAwards(client, "challenge", challengeId) : [];
  const { rows } = await client.query<{ is_anonymous: boolean; assignee_id: string | null }>(`select is_anonymous, assignee_id from challenges where id = $1`, [
    challengeId,
  ]);
  const c = rows[0];
  if (!c) return [];
  const item = { itemType: "challenge" as const, itemId: challengeId };
  // §24.6: an external challenge has no team — only its assignee can earn on it.
  const team = await teamOf(client, "challenge", challengeId);
  const credited = c.is_anonymous ? [] : team;
  if (status === "valid") {
    return credited.map((userId) => ({ ...item, userId, reason: "challenge_validated" as const, awardKey: awardKey.challengeValidated(challengeId) }));
  }
  const out: AwardInput[] = credited.map((userId) => ({ ...item, userId, reason: "challenge_solved" as const, awardKey: awardKey.challengeSolved(challengeId) }));
  if (c.assignee_id && !team.includes(c.assignee_id)) {
    out.push({ ...item, userId: c.assignee_id, reason: "assignment_solved", awardKey: awardKey.assignmentSolved(challengeId) });
  }
  out.push(...hypers);
  return out;
}

/** The awards a solution's team earns on entering `valid` or `implemented`. */
export async function solutionStatusAwards(client: PoolClient, solutionId: string, status: string): Promise<AwardInput[]> {
  if (status !== "valid" && status !== "implemented") return [];
  // §26.7: the hypers' Talent Scout markers do not depend on the author's anonymity — the award
  // goes to the hyper, whose hype is public, and names no item anywhere.
  const hypers = status === "implemented" ? await hypeFulfilledAwards(client, "solution", solutionId) : [];
  const team = (await namedTeam(client, "solution", solutionId)) ?? [];
  const item = { itemType: "solution" as const, itemId: solutionId };
  return status === "valid"
    ? team.map((userId) => ({ ...item, userId, reason: "solution_validated" as const, awardKey: awardKey.solutionValidated(solutionId) }))
    : [...team.map((userId) => ({ ...item, userId, reason: "solution_implemented" as const, awardKey: awardKey.solutionImplemented(solutionId) })), ...hypers];
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

/** §26.7 `hype_received` for each member of the hyped item's team — 3 points, the first 10 a UTC
 *  day. Never while the item is anonymous (a self-reveal replays it); hyping an item you are a member
 *  of is refused before this (§26.3, §39.9). */
export async function awardHypeReceived(client: PoolClient, parentType: AwardItemType, parentId: string, hyperId: string): Promise<void> {
  const team = await namedTeam(client, parentType, parentId);
  // An external challenge (§24.6) has no team to credit.
  if (!team || team.includes(hyperId)) return;
  await write(
    client,
    team.map((userId) => ({ userId, reason: "hype_received" as const, itemType: parentType, itemId: parentId, awardKey: awardKey.hypeReceived(parentType, parentId, hyperId) })),
  );
}

/** Writes a batch the caller gathered (a challenge transition, or the §8.3 auto-close's three
 *  awards together) — one call, so one event 13 inbox row per transaction. */
export async function writeLiveAwards(client: PoolClient, awards: AwardInput[]): Promise<void> {
  await write(client, awards);
}

/** `like_received` for each member of the liked item's team — never for a like by a member (a like
 *  by any member earns no member anything, §39.9), never while the item is anonymous. Unliking
 *  deducts nothing, and a re-like reuses the same key. */
export async function awardLikeReceived(client: PoolClient, parentType: AwardItemType, parentId: string, likerId: string): Promise<void> {
  const team = await namedTeam(client, parentType, parentId);
  // An external challenge (§24.6) has no team to credit.
  if (!team || team.includes(likerId)) return;
  await write(
    client,
    team.map((userId) => ({
      userId,
      reason: "like_received" as const,
      itemType: parentType,
      itemId: parentId,
      awardKey: awardKey.likeReceived(parentType, parentId, likerId),
    })),
  );
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

/** §38.10 `idea_approved` — 10 points to a feature idea's proposer when a platform admin approves
 *  it (never a merge, a decline or a spam delete). Item-less: an idea is not a challenge or solution,
 *  and the row must outlive the idea's delete. */
export async function awardIdeaApproved(client: PoolClient, proposerId: string, ideaId: string): Promise<void> {
  await write(client, [{ userId: proposerId, reason: "idea_approved", itemType: null, itemId: null, awardKey: awardKey.ideaApproved(ideaId) }]);
}

/** §38.10 `idea_shipped` — 25 points when the planned idea is deleted as shipped; drives Roadmapper. */
export async function awardIdeaShipped(client: PoolClient, proposerId: string, ideaId: string): Promise<void> {
  await write(client, [{ userId: proposerId, reason: "idea_shipped", itemType: null, itemId: null, awardKey: awardKey.ideaShipped(ideaId) }]);
}

/** §9 self-reveal: replays every award the item already earned for its author, backdated to the
 *  original event times — written only now, in the reveal's transaction. An anonymous item's only
 *  member is its author (§39.3), so the team replay credits exactly them. */
export async function replayOnSelfReveal(client: PoolClient, itemType: AwardItemType, itemId: string): Promise<void> {
  const awards =
    itemType === "challenge" ? await challengeAwardsSoFar(client, itemId, { author: true, assignee: false }) : await solutionAwardsSoFar(client, itemId);
  await write(client, awards);
}

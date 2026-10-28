// The §12.1 status / assignment notification events (INNOBOX_SPEC.md §7.2, §7.3, §8.3, §12.1),
// built ONCE and shared by every path that can cause them: the detail-page PATCH / assign routes
// AND the §14.1 triage bulk actions ("a real transition fires the same §12.1 notifications
// regardless of mode"). Recipient rules (dedup, actor exclusion, visibility drop, preference
// mute) live in ./notify; this module only decides WHO the candidates are and WHAT the message
// says. Messages never carry an author's identity, so anonymity (§9) cannot leak through them.
// Relative imports only (no `@/`) so the gated .dbtest.ts suites run under the plain node runner.
import {
  challengeAuthorIdsSql,
  challengeTeamJsonSql,
  formatChallengeNumber,
  formatSolutionNumber,
  inboxNote,
  invitationMessage,
  invitationPaidOffMessage,
  invitationSubject,
  solutionAuthorIdsSql,
  teamChangeMessage,
  teamDisplayText,
  type ChallengeVisibility,
  type NotificationEventNumber,
  type NotificationTarget,
  type TeamMemberRow,
} from "@innobox/shared";
import { CHALLENGE_STATUS_LABEL, SOLUTION_STATUS_LABEL } from "../app/challenges/status";
import { itemHref } from "./deep-link";
import type { InvitationPayoff } from "./invitation-payoffs";
import {
  dispatchCoalescedComment,
  dispatchCoalescedHype,
  dispatchEvent,
  dispatchInAppEvent,
  dispatchInvitation,
  dispatchTeamChange,
  dispatchTopicNotices,
  dispatchToUser,
  getFollowerUserIds,
  getNamespaceAdminUserIds,
  getNamespaceCommitteeUserIds,
  getOtherCommenterUserIds,
  type NotifyContext,
} from "./notify";

const digitsOf = (n: string | number): string => String(n).replace(/\D/g, "");
const humanStatus = (s: string): string => s.replace(/_/g, " ");

/** The three status-event flavours (§12.1 events 3/4/5) for a target status. */
function statusEventType(newStatus: string): "status_changed" | "rejected" | "needs_improvement" {
  if (newStatus === "rejected") return "rejected";
  if (newStatus === "needs_improvement") return "needs_improvement";
  return "status_changed";
}

/** The §12.1 event-matrix number of a status-event flavour — only event 3 can be held for a digest. */
const STATUS_EVENT_NUMBER: Record<ReturnType<typeof statusEventType>, NotificationEventNumber> = {
  status_changed: 3,
  rejected: 4,
  needs_improvement: 5,
};

/**
 * §12.1 events 3/4/5 for a CHALLENGE transition. Event 3 (plain status change) reaches the item's
 * authors (every member of its team, §39.8), the assignee and followers — mutable for
 * authors/followers, never for the assignee (per-item duty). Events 4 (rejected) and 5 (needs
 * improvement) are author-only, non-mutable. `challenge` is looked up by id or number (the bulk path
 * only has the number).
 */
export async function notifyChallengeStatusChanged(
  ctx: NotifyContext,
  challenge: { id: string } | { number: string },
  newStatus: string,
): Promise<void> {
  const byId = "id" in challenge;
  const { rows } = await ctx.pool.query<{ id: string; number: string; title: string; author_ids: string[]; assignee_id: string | null }>(
    `select c.id, c.number::text, c.title, ${challengeAuthorIdsSql("c")} as author_ids, c.assignee_id
       from challenges c where ${byId ? "c.id = $1" : "c.number = $1"}`,
    [byId ? challenge.id : digitsOf(challenge.number)],
  );
  const row = rows[0];
  if (!row) return;
  const label = `CH-${row.number}`;
  const type = statusEventType(newStatus);
  const message =
    type === "rejected"
      ? `${label} "${row.title}" was rejected.`
      : type === "needs_improvement"
        ? `${label} "${row.title}" needs improvement — edit and resubmit.`
        : `${label} "${row.title}" moved to ${humanStatus(newStatus)}.`;
  const assignee = row.assignee_id ? [row.assignee_id] : [];
  const recipients = type === "status_changed" ? [...row.author_ids, ...assignee, ...(await getFollowerUserIds(ctx.pool, "challenge", row.id))] : row.author_ids;
  await dispatchEvent(
    ctx,
    { parentType: "challenge", parentId: row.id },
    recipients,
    type,
    { message, link: itemHref(row.number) },
    type === "status_changed" ? { preference: "followedStatus", exempt: assignee } : undefined,
    {
      event: STATUS_EVENT_NUMBER[type],
      facts: { kind: "status", challengeNumber: row.number, challengeTitle: row.title, statusLabel: CHALLENGE_STATUS_LABEL[newStatus] ?? humanStatus(newStatus) },
    },
  );
}

/** What the §8.3 auto-close cascade hands the event-8 dispatch. */
export interface AutoCloseInfo {
  challengeId: string;
  challengeNumber: string;
  challengeTitle: string;
  notSelectedAuthorIds: string[];
  /** The implemented solution plus every sibling just closed as not_selected. */
  solutionIds: string[];
}

/**
 * §12.1 events 3/4/5 for a SOLUTION transition, plus event 8 when the transition was
 * `implemented` and triggered the §8.3 auto-close. A solution has no assignee of its own — the
 * "assignee" of event 3 is the parent challenge's assignee (the per-challenge reviewer, §4.2),
 * exempt from the mute exactly like on a challenge.
 */
export async function notifySolutionStatusChanged(
  ctx: NotifyContext,
  solutionId: string,
  newStatus: string,
  autoClose?: AutoCloseInfo,
): Promise<void> {
  const { rows } = await ctx.pool.query<{
    number: string;
    author_ids: string[];
    challenge_number: string;
    challenge_title: string;
    challenge_author_ids: string[];
    assignee_id: string | null;
  }>(
    `select s.number::text, ${solutionAuthorIdsSql("s")} as author_ids, c.number::text as challenge_number, c.title as challenge_title,
            ${challengeAuthorIdsSql("c")} as challenge_author_ids, c.assignee_id
       from solutions s join challenges c on c.id = s.challenge_id where s.id = $1`,
    [solutionId],
  );
  const row = rows[0];
  if (!row) return;

  const where = `SOL-${row.number} on CH-${row.challenge_number} "${row.challenge_title}"`;
  const type = statusEventType(newStatus);
  const message =
    type === "rejected"
      ? `Solution ${where} was rejected.`
      : type === "needs_improvement"
        ? `Solution ${where} needs improvement — edit and resubmit.`
        : `Solution ${where} moved to ${humanStatus(newStatus)}.`;
  const assignee = row.assignee_id ? [row.assignee_id] : [];
  const recipients = type === "status_changed" ? [...row.author_ids, ...assignee, ...(await getFollowerUserIds(ctx.pool, "solution", solutionId))] : row.author_ids;
  await dispatchEvent(
    ctx,
    { parentType: "solution", parentId: solutionId },
    recipients,
    type,
    { message, link: itemHref(row.challenge_number, row.number) },
    type === "status_changed" ? { preference: "followedStatus", exempt: assignee } : undefined,
    {
      event: STATUS_EVENT_NUMBER[type],
      facts: {
        kind: "status",
        challengeNumber: row.challenge_number,
        challengeTitle: row.challenge_title,
        solutionNumber: row.number,
        statusLabel: SOLUTION_STATUS_LABEL[newStatus] ?? humanStatus(newStatus),
      },
    },
  );

  if (autoClose) await notifyAutoClose(ctx, { ...autoClose, challengeAuthorIds: row.challenge_author_ids, implementedSolutionNumber: row.number });
}

/**
 * §12.1 event 8 (solution implemented → auto-close): the CHALLENGE's team, the teams of the
 * siblings just closed as not_selected (§39.8), and the followers of the challenge and of its
 * solutions (the implemented one and every closed sibling). Non-mutable. Deduplicated and
 * visibility-filtered against the challenge by dispatchEvent.
 */
async function notifyAutoClose(ctx: NotifyContext, info: AutoCloseInfo & { challengeAuthorIds: string[]; implementedSolutionNumber: string }): Promise<void> {
  const [challengeFollowers, ...solutionFollowers] = await Promise.all([
    getFollowerUserIds(ctx.pool, "challenge", info.challengeId),
    ...info.solutionIds.map((sid) => getFollowerUserIds(ctx.pool, "solution", sid)),
  ]);
  const number = digitsOf(info.challengeNumber);
  await dispatchEvent(
    ctx,
    { parentType: "challenge", parentId: info.challengeId },
    [...info.challengeAuthorIds, ...info.notSelectedAuthorIds, ...challengeFollowers!, ...solutionFollowers.flat()],
    "solution_implemented",
    {
      message: `CH-${number} "${info.challengeTitle}" was solved — a solution was implemented.`,
      link: itemHref(number),
    },
    undefined,
    {
      event: 8,
      facts: { kind: "implemented", challengeNumber: number, challengeTitle: info.challengeTitle, solutionNumber: info.implementedSolutionNumber },
    },
  );
}

/**
 * §12.1 event 7 (assigned / unassigned, §7.3). Each party hears about their own side of the
 * change: on a reassignment the previous assignee is told they were unassigned AND the new one
 * that they were assigned. Re-assigning the same person is no change and notifies nobody.
 */
export async function notifyAssignmentChanged(
  ctx: NotifyContext,
  challenge: { id: string; number: string; title: string },
  previousAssigneeId: string | null,
  newAssigneeId: string | null,
): Promise<void> {
  if (previousAssigneeId === newAssigneeId) return;
  const number = digitsOf(challenge.number);
  const link = itemHref(number);
  const target = { parentType: "challenge", parentId: challenge.id } as const;
  if (previousAssigneeId) {
    await dispatchToUser(ctx, previousAssigneeId, "challenge_assigned", {
      message: `You were unassigned from CH-${number} "${challenge.title}".`,
      link,
    }, target);
  }
  if (newAssigneeId) {
    await dispatchToUser(ctx, newAssigneeId, "challenge_assigned", {
      message: `You were assigned to CH-${number} "${challenge.title}".`,
      link,
    }, target);
  }
}

/**
 * §12.1 event 2 (solution proposed): namespace admins + committee, the challenge author and the
 * challenge's followers. Visible per the challenge (its followers hear about it), but ABOUT the
 * new solution: the link scrolls to it (§12.1) and the row carries it as its target, so deleting
 * the solution takes the row with it (§10.3). Mutable for the author and followers; for admins
 * and the committee it is an attention event (triage is a duty), so they are exempt.
 */
export async function notifySolutionProposed(
  ctx: NotifyContext,
  challengeNumber: string,
  solution: { id: string; number: string },
): Promise<void> {
  const number = digitsOf(challengeNumber);
  const { rows } = await ctx.pool.query<{ id: string; title: string; namespace_id: string; author_ids: string[] }>(
    `select c.id, c.title, c.namespace_id, ${challengeAuthorIdsSql("c")} as author_ids from challenges c where c.number = $1`,
    [number],
  );
  const challenge = rows[0];
  if (!challenge) return;
  const [admins, committee, followers] = await Promise.all([
    getNamespaceAdminUserIds(ctx.pool, challenge.namespace_id),
    getNamespaceCommitteeUserIds(ctx.pool, challenge.namespace_id),
    getFollowerUserIds(ctx.pool, "challenge", challenge.id),
  ]);
  await dispatchEvent(
    ctx,
    { parentType: "challenge", parentId: challenge.id },
    [...admins, ...committee, ...challenge.author_ids, ...followers],
    "solution_proposed",
    {
      message: `A new solution was proposed on CH-${number} "${challenge.title}".`,
      link: itemHref(number, solution.number),
      parentType: "solution",
      parentId: solution.id,
    },
    { preference: "followedSolutions", exempt: [...admins, ...committee] },
    // Held for the author and followers only — to admins and the committee it is an attention event.
    { event: 2, adminRoute: [...admins, ...committee], facts: { kind: "solution", challengeNumber: number, challengeTitle: challenge.title } },
  );
}

/**
 * §12.1 event 1 (challenge submitted): the namespace's admins, to triage it. Shared by the submit
 * route and the §25 `submit_challenge` tool, so both fire the same event.
 */
export async function notifyChallengeSubmitted(
  ctx: NotifyContext,
  challenge: { id: string; number: string; title: string; namespaceId: string },
): Promise<void> {
  await dispatchEvent(
    ctx,
    { parentType: "challenge", parentId: challenge.id },
    await getNamespaceAdminUserIds(ctx.pool, challenge.namespaceId),
    "challenge_submitted",
    {
      // Both callers pass the display number ("CH-412"); normalize so it is prefixed exactly once.
      message: `New challenge ${formatChallengeNumber(digitsOf(challenge.number))} "${challenge.title}" needs triage.`,
      link: `/challenges/${digitsOf(challenge.number)}`,
    },
  );
}

/** §12.1 event 9 (challenge resubmitted, §10.1): the namespace's admins + committee, the assignee
 *  and the challenge's followers. Shared by the resubmit route and the §25 `resubmit` tool. */
export async function notifyChallengeResubmitted(
  ctx: NotifyContext,
  number: string,
  result: { challengeId: string; namespaceId: string; title: string; assigneeId: string | null },
): Promise<void> {
  const [admins, committee, followers] = await Promise.all([
    getNamespaceAdminUserIds(ctx.pool, result.namespaceId),
    getNamespaceCommitteeUserIds(ctx.pool, result.namespaceId),
    getFollowerUserIds(ctx.pool, "challenge", result.challengeId),
  ]);
  const candidates = [...admins, ...committee, ...(result.assigneeId ? [result.assigneeId] : []), ...followers];
  await dispatchEvent(ctx, { parentType: "challenge", parentId: result.challengeId }, candidates, "status_changed", {
    message: `${formatChallengeNumber(number)} "${result.title}" was resubmitted for review.`,
    link: `/challenges/${digitsOf(number)}`,
  });
}

/** §12.1 event 9 for a solution: the parent namespace's admins + committee, the parent
 *  challenge's assignee and the solution's followers. */
export async function notifySolutionResubmitted(
  ctx: NotifyContext,
  number: string,
  result: { solutionId: string; namespaceId: string; challengeNumber: string; challengeTitle: string; assigneeId: string | null },
): Promise<void> {
  const [admins, committee, followers] = await Promise.all([
    getNamespaceAdminUserIds(ctx.pool, result.namespaceId),
    getNamespaceCommitteeUserIds(ctx.pool, result.namespaceId),
    getFollowerUserIds(ctx.pool, "solution", result.solutionId),
  ]);
  const candidates = [...admins, ...committee, ...(result.assigneeId ? [result.assigneeId] : []), ...followers];
  await dispatchEvent(ctx, { parentType: "solution", parentId: result.solutionId }, candidates, "status_changed", {
    message: `${formatSolutionNumber(number)} on ${result.challengeNumber} "${result.challengeTitle}" was resubmitted for review.`,
    link: `/challenges/${digitsOf(result.challengeNumber)}#SOL-${digitsOf(number)}`,
  });
}

/**
 * §12.1 event 6 (comment posted), coalesced: the item author, its other commenters and followers —
 * never the commenter. Messages reference the parent CHALLENGE (solutions have no title); the
 * recipients are scoped to the comment's actual parent. A reply (§10.2) also counts as a reply for
 * the author of the comment it answers (`replyToAuthorId`). Shared by the comments route and the
 * §25 `post_comment` tool.
 */
export async function notifyCommentPosted(
  ctx: NotifyContext,
  parentType: "challenge" | "solution",
  parentId: string,
  commenterId: string,
  replyToAuthorId: string | null = null,
): Promise<void> {
  const item =
    parentType === "challenge"
      ? await ctx.pool
          .query<{ id: string; number: string; title: string; author_ids: string[] }>(
            `select c.id, c.number::text, c.title, ${challengeAuthorIdsSql("c")} as author_ids from challenges c where c.id = $1`,
            [parentId],
          )
          .then((r) =>
            r.rows[0]
              ? { id: r.rows[0].id, authorIds: r.rows[0].author_ids, challengeId: r.rows[0].id, challengeNumber: r.rows[0].number, challengeTitle: r.rows[0].title, solutionNumber: null }
              : null,
          )
      : await ctx.pool
          .query<{ id: string; number: string; author_ids: string[]; challenge_id: string; challenge_number: string; challenge_title: string }>(
            `select s.id, s.number::text as number, ${solutionAuthorIdsSql("s")} as author_ids, c.id as challenge_id, c.number::text as challenge_number,
                    c.title as challenge_title
               from solutions s join challenges c on c.id = s.challenge_id where s.id = $1`,
            [parentId],
          )
          .then((r) =>
            r.rows[0]
              ? {
                  id: r.rows[0].id,
                  authorIds: r.rows[0].author_ids,
                  challengeId: r.rows[0].challenge_id,
                  challengeNumber: r.rows[0].challenge_number,
                  challengeTitle: r.rows[0].challenge_title,
                  // §12.1 deep link: a solution resolves to its parent challenge page, scrolled to it.
                  solutionNumber: r.rows[0].number,
                }
              : null,
          );
  if (!item) return;
  const { rows: who } = await ctx.pool.query<{ display_name: string }>(`select display_name from users where id = $1`, [commenterId]);

  const [otherCommenters, followers] = await Promise.all([
    getOtherCommenterUserIds(ctx.pool, parentType, item.id),
    getFollowerUserIds(ctx.pool, parentType, item.id),
  ]);
  await dispatchCoalescedComment(
    ctx,
    // The author of a comment answered is always among the other commenters (§10.2). The item's
    // authors are its whole team (§39.8).
    [...item.authorIds, ...otherCommenters, ...followers],
    {
      parentType,
      parentId: item.id,
      challengeId: item.challengeId,
      challengeNumber: formatChallengeNumber(item.challengeNumber),
      challengeTitle: item.challengeTitle,
      latestBy: who[0]?.display_name ?? "Someone",
      link: itemHref(item.challengeNumber, item.solutionNumber),
      replyToAuthorId,
    },
    // §12.1: mutable for every recipient route — an author who mutes it hears no comments on
    // their own item either.
    { preference: "followedComments" },
  );
}

/**
 * §12.1 event 16 (hyped, §26.6): the hyped item's authors only — every member of its team (§39.8).
 * Shared by the hype route; called after the hype committed. `hype` is the item's points after this
 * hype.
 */
export async function notifyHyped(ctx: NotifyContext, parentType: "challenge" | "solution", parentId: string, hyperId: string, hype: number): Promise<void> {
  const { rows } = await ctx.pool.query<{
    author_ids: string[];
    challenge_id: string;
    challenge_number: string;
    challenge_title: string;
    solution_number: string | null;
  }>(
    parentType === "challenge"
      ? `select ${challengeAuthorIdsSql("c")} as author_ids, c.id as challenge_id, c.number::text as challenge_number, c.title as challenge_title,
                null::text as solution_number
           from challenges c where c.id = $1`
      : `select ${solutionAuthorIdsSql("s")} as author_ids, c.id as challenge_id, c.number::text as challenge_number, c.title as challenge_title,
                s.number::text as solution_number
           from solutions s join challenges c on c.id = s.challenge_id where s.id = $1`,
    [parentId],
  );
  const item = rows[0];
  if (!item) return;
  const { rows: who } = await ctx.pool.query<{ display_name: string }>(`select display_name from users where id = $1`, [hyperId]);
  const challengeNumber = formatChallengeNumber(item.challenge_number);
  const itemNumber = item.solution_number ? formatSolutionNumber(item.solution_number) : challengeNumber;
  const itemLabel = item.solution_number
    ? `solution ${itemNumber} on ${challengeNumber} "${item.challenge_title}"`
    : `challenge ${challengeNumber} "${item.challenge_title}"`;
  await dispatchCoalescedHype(ctx, item.author_ids, {
    parentType,
    parentId,
    challengeId: item.challenge_id,
    itemNumber,
    itemLabel,
    latestBy: who[0]?.display_name ?? "Someone",
    hype,
    link: itemHref(item.challenge_number, item.solution_number),
    challengeNumber,
    challengeTitle: item.challenge_title,
    solutionNumber: item.solution_number,
  });
}

/** What caused an event-18 evaluation (§34.5): the challenge's opening (its first entry into
 *  `valid`), topics added while it is `valid`, or its visibility changing while it is `valid`. */
export type TopicTrigger =
  | { via: "opening" }
  | { via: "topic_added"; topicIds: readonly string[] }
  | { via: "widened"; previousVisibility: ChallengeVisibility };

/**
 * §12.1 event 18 (§34.5): tell the followers of a challenge's relevant topics — every active topic
 * on it, or only the added ones — that it is open for solutions. Called after the triggering change
 * committed, by every path that can cause one: a status change (detail page and bulk), an admin's
 * re-tag (detail page and bulk) and a visibility change. Sends nothing unless the challenge is
 * `valid`, not trashed, and its namespace is not archived (it then accepts no solutions, §4.1);
 * followers who were already told about it (`topic_notices`) are left out up front.
 */
export async function notifyTopicFollowers(ctx: NotifyContext, challengeId: string, trigger: TopicTrigger): Promise<void> {
  const { rows } = await ctx.pool.query<{
    number: string;
    title: string;
    status: string;
    trashed: boolean;
    archived: boolean;
    slug: string;
    author_id: string | null;
    is_anonymous: boolean;
    author_display_name: string | null;
    company: string | null;
    team: TeamMemberRow[];
  }>(
    `select c.number::text, c.title, c.status, c.trashed_at is not null as trashed, ns.archived_at is not null as archived, ns.slug,
            c.author_id, c.is_anonymous, u.display_name as author_display_name, ps.company, ${challengeTeamJsonSql("c")} as team
       from challenges c
       join namespaces ns on ns.id = c.namespace_id
       left join users u on u.id = c.author_id
       left join public_submissions ps on ps.id = c.public_submission_id
      where c.id = $1`,
    [challengeId],
  );
  const challenge = rows[0];
  if (!challenge || challenge.status !== "valid" || challenge.trashed || challenge.archived) return;

  const onlyTopics = trigger.via === "topic_added" ? [...trigger.topicIds] : null;
  if (onlyTopics !== null && onlyTopics.length === 0) return;
  // Each follower of a relevant ACTIVE topic, with the names of the relevant topics they follow;
  // a retired topic never triggers (§34.2).
  const { rows: follows } = await ctx.pool.query<{ user_id: string; names: string[] }>(
    `select f.user_id, array_agg(t.name order by lower(t.name)) as names
       from challenge_topics ct
       join topics t on t.id = ct.topic_id and t.active
       join topic_follows f on f.topic_id = t.id
      where ct.challenge_id = $1
        and ($2::uuid[] is null or t.id = any($2::uuid[]))
        and not exists (select 1 from topic_notices n where n.challenge_id = $1 and n.user_id = f.user_id)
      group by f.user_id`,
    [challengeId, onlyTopics],
  );
  if (follows.length === 0) return;

  await dispatchTopicNotices(ctx, {
    challenge: {
      id: challengeId,
      number: challenge.number,
      title: challenge.title,
      namespaceSlug: challenge.slug,
      // §39.7: the first member plus "and N others", masked per §9.
      author: teamDisplayText({
        isAnonymous: challenge.is_anonymous,
        authorId: challenge.author_id,
        authorDisplayName: challenge.author_display_name,
        externalCompany: challenge.company,
        team: challenge.team,
      }),
    },
    followers: new Map(follows.map((r) => [r.user_id, r.names])),
    authorIds: challenge.team.map((m) => m.id),
    via: trigger.via,
    ...(trigger.via === "widened" ? { previousVisibility: trigger.previousVisibility } : {}),
  });
}

/** What an event-21 message names: the item ("CH-12" / "SOL-34") and its parent challenge. */
interface TeamItemRef {
  itemNumber: string;
  challengeNumber: string;
  challengeTitle: string;
  solutionNumber: string | null;
}

/** The item a create's co-authors were added to, read after the commit. */
async function teamItemRef(ctx: NotifyContext, target: NotificationTarget): Promise<TeamItemRef | null> {
  const { rows } = await ctx.pool.query<{ challenge_number: string; challenge_title: string; solution_number: string | null }>(
    target.parentType === "challenge"
      ? `select c.number::text as challenge_number, c.title as challenge_title, null::text as solution_number from challenges c where c.id = $1`
      : `select c.number::text as challenge_number, c.title as challenge_title, s.number::text as solution_number
           from solutions s join challenges c on c.id = s.challenge_id where s.id = $1`,
    [target.parentId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    itemNumber: r.solution_number ? formatSolutionNumber(r.solution_number) : formatChallengeNumber(r.challenge_number),
    challengeNumber: r.challenge_number,
    challengeTitle: r.challenge_title,
    solutionNumber: r.solution_number,
  };
}

/**
 * §12.1 event 21 (§39.8): "Ana Petrova added you as a co-author of SOL-34" — to the one person another
 * member added or removed, in-app and by e-mail (the subject is the same line; the body carries the
 * number, the title, the actor's name and the link). Immediate, never digested, not mutable; the
 * daily e-mail cap and the drops live in dispatchTeamChange. Called after the change committed.
 */
export async function notifyTeamChange(
  ctx: NotifyContext,
  change: { userId: string; change: "added" | "removed"; target: NotificationTarget } & TeamItemRef,
): Promise<void> {
  if (!ctx.actorId) return;
  const { rows } = await ctx.pool.query<{ display_name: string }>(`select display_name from users where id = $1`, [ctx.actorId]);
  const message = teamChangeMessage(rows[0]?.display_name ?? "Someone", change.change, change.itemNumber);
  const where = change.solutionNumber
    ? `${change.itemNumber} on ${formatChallengeNumber(change.challengeNumber)} "${change.challengeTitle}"`
    : `${change.itemNumber} "${change.challengeTitle}"`;
  await dispatchTeamChange(
    ctx,
    change.userId,
    { message, subject: message, emailDetail: where, link: itemHref(change.challengeNumber, change.solutionNumber) },
    change.target,
  );
}

/** §12.1 event 21 for a create with co-authors: one per co-author, with the creator as the actor. */
export async function notifyCoAuthorsAdded(ctx: NotifyContext, target: NotificationTarget, coAuthorIds: readonly string[]): Promise<void> {
  if (coAuthorIds.length === 0) return;
  const ref = await teamItemRef(ctx, target);
  if (!ref) return;
  for (const userId of coAuthorIds) await notifyTeamChange(ctx, { userId, change: "added", target, ...ref });
}

/**
 * §12.1 event 22 (§40.6): each invitation of a send, to its invitee — "Ana Petrova invited you to
 * propose a solution to CH-412 …", the note quoted on the bell's second line. The e-mail adds the
 * namespace, the author masked per §9 (or the §24.6 label) and the note in full, never the
 * description. An invitee who chose *Not for me* on the challenge gets nothing (§40.3); the mute, the
 * drops and the daily e-mail cap live in dispatchInvitation. Called after the send committed.
 */
export async function notifyInvited(ctx: NotifyContext, challengeId: string, invitations: readonly { inviteeId: string; note: string | null }[]): Promise<void> {
  if (!ctx.actorId || invitations.length === 0) return;
  const { rows } = await ctx.pool.query<{
    number: string;
    title: string;
    slug: string;
    author_id: string | null;
    is_anonymous: boolean;
    author_display_name: string | null;
    company: string | null;
    team: TeamMemberRow[];
  }>(
    `select c.number::text, c.title, ns.slug, c.author_id, c.is_anonymous, u.display_name as author_display_name, ps.company,
            ${challengeTeamJsonSql("c")} as team
       from challenges c
       join namespaces ns on ns.id = c.namespace_id
       left join users u on u.id = c.author_id
       left join public_submissions ps on ps.id = c.public_submission_id
      where c.id = $1`,
    [challengeId],
  );
  const challenge = rows[0];
  if (!challenge) return;
  const { rows: who } = await ctx.pool.query<{ display_name: string }>(`select display_name from users where id = $1`, [ctx.actorId]);
  const inviterName = who[0]?.display_name ?? "Someone";
  const { rows: dismissed } = await ctx.pool.query<{ user_id: string }>(
    `select user_id from challenge_invitation_dismissals where challenge_id = $1 and user_id = any($2::uuid[])`,
    [challengeId, invitations.map((i) => i.inviteeId)],
  );
  const silenced = new Set(dismissed.map((r) => r.user_id));
  const author = teamDisplayText({
    isAnonymous: challenge.is_anonymous,
    authorId: challenge.author_id,
    authorDisplayName: challenge.author_display_name,
    externalCompany: challenge.company,
    team: challenge.team,
  });
  for (const invitation of invitations) {
    if (silenced.has(invitation.inviteeId)) continue;
    const note = invitation.note;
    await dispatchInvitation(ctx, invitation.inviteeId, challengeId, {
      message: invitationMessage(inviterName, challenge.number, challenge.title),
      subject: invitationSubject(inviterName, challenge.number),
      // The bell's second line (§40.6), and the e-mail's lines under the message.
      ...(note ? { detail: `"${inboxNote(note)}"` } : {}),
      emailDetail: `In /${challenge.slug} · submitted by ${author}${note ? `\n\n${inviterName}'s note:\n"${note}"` : ""}`,
      link: itemHref(challenge.number),
      parentType: "challenge",
      parentId: challengeId,
      challengeId,
      number: formatChallengeNumber(challenge.number),
      title: challenge.title,
      inviterId: ctx.actorId,
      inviterName,
      note,
    });
  }
}

/**
 * §12.1 event 23 (§40.6): each invitation a solution paid off, to its inviter — in-app only, written
 * whether or not gamification is on, with no preference. Naming the invitee is safe: the solution is
 * named and, out of `proposed`, visible to anyone who can see the challenge — which the visibility
 * drop checks for the inviter. Called after the transition or the self-reveal committed.
 */
export async function notifyInvitationPayoffs(ctx: NotifyContext, payoffs: readonly InvitationPayoff[]): Promise<void> {
  if (payoffs.length === 0) return;
  const { rows } = await ctx.pool.query<{ id: string; solution_number: string; challenge_number: string; invitee_name: string }>(
    `select i.id::text as id, s.number::text as solution_number, c.number::text as challenge_number, u.display_name as invitee_name
       from challenge_invitations i
       join solutions s on s.id = i.paid_off_solution_id
       join challenges c on c.id = s.challenge_id
       join users u on u.id = i.invitee_id
      where i.id = any($1::bigint[])`,
    [payoffs.map((p) => p.invitationId)],
  );
  const facts = new Map(rows.map((r) => [r.id, r]));
  for (const payoff of payoffs) {
    const f = facts.get(payoff.invitationId);
    if (!f) continue;
    await dispatchInAppEvent(ctx, { parentType: "solution", parentId: payoff.solutionId }, [payoff.inviterId], "invitation_paid_off", {
      message: invitationPaidOffMessage(f.invitee_name, f.solution_number, f.challenge_number),
      link: itemHref(f.challenge_number, f.solution_number),
      parentType: "solution",
      parentId: payoff.solutionId,
      challengeId: payoff.challengeId,
      inviteeName: f.invitee_name,
      challengeNumber: formatChallengeNumber(f.challenge_number),
      solutionNumber: formatSolutionNumber(f.solution_number),
    });
  }
}

/** Notification failures are logged, never thrown — the state change already committed. */
export function logNotifyFailure(msg: string): (err: unknown) => void {
  return (err) => console.error(JSON.stringify({ level: "error", msg, error: String(err) }));
}

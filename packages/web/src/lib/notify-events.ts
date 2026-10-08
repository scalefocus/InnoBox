// The §12.1 status / assignment notification events (INNOBOX_SPEC.md §7.2, §7.3, §8.3, §12.1),
// built ONCE and shared by every path that can cause them: the detail-page PATCH / assign routes
// AND the §14.1 triage bulk actions ("a real transition fires the same §12.1 notifications
// regardless of mode"). Recipient rules (dedup, actor exclusion, visibility drop, preference
// mute) live in ./notify; this module only decides WHO the candidates are and WHAT the message
// says. Messages never carry an author's identity, so anonymity (§9) cannot leak through them.
// Relative imports only (no `@/`) so the gated .dbtest.ts suites run under the plain node runner.
import { itemHref } from "./deep-link";
import { dispatchEvent, dispatchToUser, getFollowerUserIds, type NotifyContext } from "./notify";

const digitsOf = (n: string | number): string => String(n).replace(/\D/g, "");
const humanStatus = (s: string): string => s.replace(/_/g, " ");

/** The three status-event flavours (§12.1 events 3/4/5) for a target status. */
function statusEventType(newStatus: string): "status_changed" | "rejected" | "needs_improvement" {
  if (newStatus === "rejected") return "rejected";
  if (newStatus === "needs_improvement") return "needs_improvement";
  return "status_changed";
}

/**
 * §12.1 events 3/4/5 for a CHALLENGE transition. Event 3 (plain status change) reaches the item
 * author, the assignee and followers — mutable for authors/followers, never for the assignee
 * (per-item duty). Events 4 (rejected) and 5 (needs improvement) are author-only, non-mutable.
 * `challenge` is looked up by id or number (the bulk path only has the number).
 */
export async function notifyChallengeStatusChanged(
  ctx: NotifyContext,
  challenge: { id: string } | { number: string },
  newStatus: string,
): Promise<void> {
  const byId = "id" in challenge;
  const { rows } = await ctx.pool.query<{ id: string; number: string; title: string; author_id: string; assignee_id: string | null }>(
    `select id, number::text, title, author_id, assignee_id from challenges where ${byId ? "id = $1" : "number = $1"}`,
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
  const recipients = type === "status_changed" ? [row.author_id, ...assignee, ...(await getFollowerUserIds(ctx.pool, "challenge", row.id))] : [row.author_id];
  await dispatchEvent(
    ctx,
    { parentType: "challenge", parentId: row.id },
    recipients,
    type,
    { message, link: itemHref(row.number) },
    type === "status_changed" ? { preference: "followedStatus", exempt: assignee } : undefined,
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
    author_id: string;
    challenge_number: string;
    challenge_title: string;
    challenge_author_id: string;
    assignee_id: string | null;
  }>(
    `select s.number::text, s.author_id, c.number::text as challenge_number, c.title as challenge_title,
            c.author_id as challenge_author_id, c.assignee_id
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
  const recipients = type === "status_changed" ? [row.author_id, ...assignee, ...(await getFollowerUserIds(ctx.pool, "solution", solutionId))] : [row.author_id];
  await dispatchEvent(
    ctx,
    { parentType: "solution", parentId: solutionId },
    recipients,
    type,
    { message, link: itemHref(row.challenge_number, row.number) },
    type === "status_changed" ? { preference: "followedStatus", exempt: assignee } : undefined,
  );

  if (autoClose) await notifyAutoClose(ctx, { ...autoClose, challengeAuthorId: row.challenge_author_id });
}

/**
 * §12.1 event 8 (solution implemented → auto-close): the CHALLENGE author, the authors of the
 * siblings just closed as not_selected, and the followers of the challenge and of its solutions
 * (the implemented one and every closed sibling). Non-mutable. Deduplicated and visibility-
 * filtered against the challenge by dispatchEvent.
 */
async function notifyAutoClose(ctx: NotifyContext, info: AutoCloseInfo & { challengeAuthorId: string }): Promise<void> {
  const [challengeFollowers, ...solutionFollowers] = await Promise.all([
    getFollowerUserIds(ctx.pool, "challenge", info.challengeId),
    ...info.solutionIds.map((sid) => getFollowerUserIds(ctx.pool, "solution", sid)),
  ]);
  const number = digitsOf(info.challengeNumber);
  await dispatchEvent(
    ctx,
    { parentType: "challenge", parentId: info.challengeId },
    [info.challengeAuthorId, ...info.notSelectedAuthorIds, ...challengeFollowers!, ...solutionFollowers.flat()],
    "solution_implemented",
    {
      message: `CH-${number} "${info.challengeTitle}" was solved — a solution was implemented.`,
      link: itemHref(number),
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
  challenge: { number: string; title: string },
  previousAssigneeId: string | null,
  newAssigneeId: string | null,
): Promise<void> {
  if (previousAssigneeId === newAssigneeId) return;
  const number = digitsOf(challenge.number);
  const link = itemHref(number);
  if (previousAssigneeId) {
    await dispatchToUser(ctx, previousAssigneeId, "challenge_assigned", {
      message: `You were unassigned from CH-${number} "${challenge.title}".`,
      link,
    });
  }
  if (newAssigneeId) {
    await dispatchToUser(ctx, newAssigneeId, "challenge_assigned", {
      message: `You were assigned to CH-${number} "${challenge.title}".`,
      link,
    });
  }
}

/** Notification failures are logged, never thrown — the state change already committed. */
export function logNotifyFailure(msg: string): (err: unknown) => void {
  return (err) => console.error(JSON.stringify({ level: "error", msg, error: String(err) }));
}

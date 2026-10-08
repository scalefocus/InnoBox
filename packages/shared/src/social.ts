// Phase 3 domain logic (INNOBOX_SPEC.md §10.2 comments, §12 notifications/follows, §7.3
// assignment): pure rules only — DB access (followers, recipients, membership) stays in the
// caller. Comments/likes are never anonymous (§9); notifications must be anonymity-safe,
// which callers satisfy by building `message` from already-masked display data.
import { CHALLENGE_TERMINAL_STATUSES, type ChallengeStatus } from "./challenges.js";

// ── Comments (§10.2) ─────────────────────────────────────────────────────────────────────

export const COMMENT_BODY_MAX = 5_000;
const COMMENT_EDIT_WINDOW_MS = 15 * 60 * 1000;

export type CommentResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateCommentBody(body: unknown): CommentResult<string> {
  if (typeof body !== "string" || body.trim() === "") return { ok: false, error: "comment body is required" };
  const trimmed = body.trim();
  if (trimmed.length > COMMENT_BODY_MAX) {
    return { ok: false, error: `comment must be at most ${COMMENT_BODY_MAX} characters` };
  }
  return { ok: true, value: trimmed };
}

/** Owner edit/delete window: 15 minutes from posting (§10.2). Admin moderation bypasses this
 *  entirely via a separate permission check (isNamespaceAdmin), not this function. */
export function canEditOwnComment(comment: { authorId: string; createdAt: Date }, viewerId: string, now: Date): boolean {
  if (comment.authorId !== viewerId) return false;
  return now.getTime() - comment.createdAt.getTime() <= COMMENT_EDIT_WINDOW_MS;
}

// ── Assignment (§7.3) ────────────────────────────────────────────────────────────────────

/** Assignment is possible from awaiting_triage onward, blocked once terminal. */
export function canAssignAtStatus(status: ChallengeStatus): boolean {
  return !CHALLENGE_TERMINAL_STATUSES.has(status);
}

// ── Notifications (§12.1) ────────────────────────────────────────────────────────────────

export const NOTIFICATION_TYPES = [
  "challenge_submitted",
  "solution_proposed",
  "status_changed",
  "rejected",
  "needs_improvement",
  "comment_posted",
  "challenge_assigned",
  "challenge_unassigned",
  "solution_implemented",
  "attachment_scan_failed",
  // §14.7: the platform admins' coalesced system-log alert — in-app only, never e-mailed.
  "system_error",
  // §12.1 event 12: the successor's one summary item when a GDPR erasure (§3) hands over
  // the erased user's open assignments.
  "assignments_transferred",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Every payload carries an already anonymity-safe message and a relative deep link (§12.1);
 *  callers may add extra fields for richer future rendering. */
export interface NotificationPayload {
  message: string;
  link: string;
  [key: string]: unknown;
}

/** §12.1 recipient rules: actors never notify themselves; recipients are deduplicated.
 *  Visibility-dropping (recipients outside the item's visibility) is applied by the caller,
 *  which has DB access to check namespace membership per candidate. */
export function finalizeRecipients(candidates: string[], actorId: string | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of candidates) {
    if (id === actorId) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// ── Coalesced comment notifications (§12.1 event 6) ──────────────────────────────────────

/**
 * The inbox/e-mail line for a coalesced comment row. The write path renders the SAME text in SQL
 * when it refreshes an unread row (lib/notify.ts `COALESCED_MESSAGE_SQL`); a dbtest pins the two
 * together. Comments carry no anonymity option (§9), so naming the commenter is safe; the item's
 * own author is never named here.
 */
export function commentNotificationMessage(count: number, challengeNumber: string, challengeTitle: string, latestBy: string): string {
  if (count <= 1) return `New comment on ${challengeNumber} "${challengeTitle}" — by ${latestBy}.`;
  return `${count} new comments on ${challengeNumber} "${challengeTitle}" — latest by ${latestBy}.`;
}

// ── Assignments transferred on erasure (§12.1 event 12) ──────────────────────────────────

/** At most this many challenge numbers are listed in the event-12 message; the rest are counted. */
export const ASSIGNMENTS_TRANSFERRED_LIST_MAX = 10;

/**
 * The inbox/e-mail line for the one summary item a successor receives when a GDPR erasure (§3)
 * hands over open assignments. `numbers` are display numbers ("CH-12"), lowest first. It never
 * names the erased person — the account is "a removed account" — and every listed challenge is
 * visible to the recipient by construction (the move was gated on it).
 */
export function assignmentsTransferredMessage(numbers: string[]): string {
  const n = numbers.length;
  const listed = numbers.slice(0, ASSIGNMENTS_TRANSFERRED_LIST_MAX).join(", ");
  const rest = n - Math.min(n, ASSIGNMENTS_TRANSFERRED_LIST_MAX);
  const head = n === 1 ? "1 challenge was reassigned to you" : `${n} challenges were reassigned to you`;
  return `${head} from a removed account: ${listed}${rest > 0 ? ` and ${rest} more` : ""}.`;
}

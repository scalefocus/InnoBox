// Mark as duplicate (INNOBOX_SPEC.md §42) — pure and CLIENT-SAFE (also exposed at
// `@innobox/shared/duplicates` for the mark dialog, the banner and the card line). Who may mark and
// from which status (§42.3 rule 1), which challenge may be the original (rules 5–6), the note's
// validation (rule 7), and every user-facing string the feature shows — the API refusals, the
// banner, the comments notice and event 25's copy. DB access and HTTP concerns stay in the caller.
import type { ChallengeStatus, ChallengeVisibility, Result } from "./challenges.js";

/** §42.3 rule 7: the optional note, after trimming. */
export const DUPLICATE_NOTE_MAX = 500;

/** §42.3: the dialog's search returns at most this many eligible originals for a typed query… */
export const DUPLICATE_CANDIDATES_MAX = 10;
/** …and at most this many similar ones before anything is typed. */
export const DUPLICATE_SIMILAR_MAX = 5;

/** §42.3 rule 1: a namespace or platform admin marks from any open status, triage included. */
const ADMIN_MARKABLE: ReadonlySet<ChallengeStatus> = new Set(["awaiting_triage", "in_review", "needs_improvement", "meeting_scheduled", "valid"]);
/** §42.3 rule 1: a committee member or the assignee marks from the statuses they may reject from (§7.2). */
const REVIEWER_MARKABLE: ReadonlySet<ChallengeStatus> = new Set(["in_review", "meeting_scheduled"]);
/** §42.3 rule 5: the statuses an original may be in — past triage, neither withdrawn nor a duplicate. */
const ORIGINAL_STATUSES: ReadonlySet<ChallengeStatus> = new Set(["in_review", "needs_improvement", "meeting_scheduled", "valid", "solved", "rejected"]);

export type DuplicateActorDecision =
  | { allowed: true; mode: "override" | "enforced" }
  /** `forbidden`: no marking role at all; `own_item`: a committee member barred only as an author of
   *  the duplicate (§39.5); `status`: a role that may mark, but not from this status. */
  | { allowed: false; reason: "forbidden" | "own_item" | "status" };

/**
 * §42.3 rule 1. `isAdmin` — a namespace admin of the duplicate's namespace or a platform admin;
 * `isEnforcer` — a committee member of the namespace who is not an author of it, or its assignee
 * (`isReviewEnforcer`, §39.5); `barredAsAuthor` — a committee member kept out only by that bar. A
 * viewer who is both admin and reviewer gets the admin's wider window (`override`).
 */
export function decideDuplicateActor(input: { status: ChallengeStatus; isAdmin: boolean; isEnforcer: boolean; barredAsAuthor?: boolean }): DuplicateActorDecision {
  if (input.isAdmin) return ADMIN_MARKABLE.has(input.status) ? { allowed: true, mode: "override" } : { allowed: false, reason: "status" };
  if (input.isEnforcer) return REVIEWER_MARKABLE.has(input.status) ? { allowed: true, mode: "enforced" } : { allowed: false, reason: "status" };
  return { allowed: false, reason: input.barredAsAuthor ? "own_item" : "forbidden" };
}

/** §42.3 rule 5: may a challenge in this status be the original? */
export function isOriginalStatusAllowed(status: ChallengeStatus): boolean {
  return ORIGINAL_STATUSES.has(status);
}

/**
 * §42.3 rule 6: the original is at least as visible as the duplicate — the original is `org`, or
 * both are `namespace` in the same namespace. Every other pair is refused, including every `people`
 * original and a `namespace` original for a `people` duplicate.
 */
export function isVisibilityPairAllowed(
  duplicate: { visibility: ChallengeVisibility; namespaceId: string },
  original: { visibility: ChallengeVisibility; namespaceId: string },
): boolean {
  if (original.visibility === "org") return true;
  return original.visibility === "namespace" && duplicate.visibility === "namespace" && original.namespaceId === duplicate.namespaceId;
}

/** §42.3 rule 7: optional, at most 500 characters after trimming; blank is stored as none. */
export function validateDuplicateNote(raw: unknown): Result<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: DUPLICATE_MESSAGES.noteTooLong };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (trimmed.length > DUPLICATE_NOTE_MAX) return { ok: false, error: DUPLICATE_MESSAGES.noteTooLong };
  return { ok: true, value: trimmed };
}

/** The original's number as the request names it: `CH-12`, `ch-12` or `12`. Null when malformed. */
export function parseOriginalNumber(raw: unknown): string | null {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  const m = /^(?:ch-)?(\d{1,12})$/i.exec(s);
  return m ? String(Number(m[1])) : null;
}

const ch = (n: string | number): string => `CH-${String(n).replace(/\D/g, "")}`;

/** Every user-facing string of §42 — no section marks (§21.9). */
export const DUPLICATE_MESSAGES = {
  wrongStatus: "This challenge can't be marked as a duplicate in its current status.",
  openSolutions: "Close this challenge's open solutions first.",
  notFound: (n: string | number) => `There is no challenge ${ch(n)} that you can see.`,
  self: "A challenge can't be a duplicate of itself.",
  originalStatus: (n: string | number) => `${ch(n)} can't be the original while it is awaiting triage or withdrawn.`,
  originalIsDuplicate: (n: string | number, root: string | number | null) =>
    root === null ? `${ch(n)} is itself closed as a duplicate.` : `${ch(n)} is itself a duplicate of ${ch(root)}. Choose ${ch(root)}.`,
  visibility: (duplicate: string | number) =>
    `Everyone who can see ${ch(duplicate)} must be able to see the original. Choose an organization-wide challenge, or a namespace-only one in the same namespace.`,
  noteTooLong: `Keep the note to ${DUPLICATE_NOTE_MAX} characters or fewer.`,
  useMarkDuplicate: "Use Mark as duplicate to choose the original.",
  commentsClosed: "This challenge was closed as a duplicate, so it takes no new comments.",
  forbidden: "Only an admin, a committee member or the assignee can mark this challenge as a duplicate.",
} as const;

/** §42.5 / §13.1: the Propose button's hint on a duplicate. */
export const DUPLICATE_PROPOSE_HINT = "This challenge was closed as a duplicate, so it does not accept solutions.";

/** §42.5: the banner on the duplicate. `original` is null when the viewer cannot see it, or the
 *  link is gone (§42.7) — then no number, title or note. */
export function duplicateBannerText(original: { number: string } | null): string {
  return original ? `Closed as a duplicate of ${ch(original.number)}` : "Closed as a duplicate.";
}

/** §42.5: the line only the duplicate's authors see under the banner. */
export function duplicateAuthorHint(original: { number: string } | null): string {
  return original
    ? `Think this is a mistake? Say so on ${ch(original.number)}, or ask an admin to reopen this challenge.`
    : "Ask an admin if you think this is a mistake.";
}

/** §42.5: in place of the comment composer and every Reply, on the challenge and its solutions. */
export function duplicateCommentsNotice(original: { number: string } | null): string {
  return original ? `Comments are closed. The discussion continues on ${ch(original.number)}.` : "Comments are closed on this challenge.";
}

/** §42.5: the muted card line, for a viewer who can see the original. */
export function duplicateOfLine(originalNumber: string): string {
  return `Duplicate of ${ch(originalNumber)}`;
}

/** §42.5: the original's "Also raised as" line. */
export function alsoRaisedAsPrefix(): string {
  return "Also raised as";
}

/** §42.3: the toast after a successful mark. */
export function duplicateMarkedToast(duplicate: string | number, original: string | number): string {
  return `${ch(duplicate)} marked as a duplicate of ${ch(original)}.`;
}

/** §42.3: what the preview read says the mark will do, one line per effect; empty lines left out. */
export interface DuplicatePreview {
  followersToMove: number;
  marksToCopy: number;
  authorsMark: boolean;
  repointed: number;
  outsideSubmitter: boolean;
  /** The duplicate has authors to tell (not a public-form challenge). */
  hasAuthors: boolean;
}

export function duplicatePreviewLines(duplicate: string | number, original: string | number, p: DuplicatePreview): string[] {
  const d = ch(duplicate);
  const o = ch(original);
  const lines = [`${d} closes, and so do its comments.`];
  if (p.followersToMove > 0) lines.push(`${p.followersToMove} ${p.followersToMove === 1 ? "follower" : "followers"} will follow ${o} instead.`);
  if (p.marksToCopy > 0 || p.authorsMark) {
    const marks = p.marksToCopy > 0 ? `${p.marksToCopy} ${p.marksToCopy === 1 ? "person's mark" : "people's marks"}` : "";
    const estimate = p.authorsMark ? "the author's estimate" : "";
    const subject = [marks, estimate].filter(Boolean).join(" and ");
    lines.push(`${subject.charAt(0).toUpperCase()}${subject.slice(1)} will count toward ${o}'s reach.`);
  }
  if (p.hasAuthors) lines.push("The author is told where the discussion continues.");
  if (p.repointed > 0) lines.push(`${p.repointed} ${p.repointed === 1 ? "challenge" : "challenges"} marked as a duplicate of ${d} will point to ${o}.`);
  if (p.outsideSubmitter) lines.push("The outside submitter is told their submission joins an existing challenge.");
  return lines;
}

// ── §12.1 event 25 — "Closed as a duplicate" (§42.6) ─────────────────────────────────────

/** The inbox and e-mail line. `original` null: the recipient cannot see it (or the link is gone) —
 *  the second form, which names no original. */
export function closedAsDuplicateMessage(input: { number: string | number; original: { number: string | number } | null; author: boolean }): string {
  const subject = input.author ? `Your challenge ${ch(input.number)}` : ch(input.number);
  return input.original
    ? `${subject} was closed as a duplicate of ${ch(input.original.number)} — the discussion continues there.`
    : `${subject} was closed as a duplicate.`;
}

export function closedAsDuplicateSubject(input: { number: string | number; author: boolean }): string {
  return input.author ? `Your challenge ${ch(input.number)} was closed as a duplicate` : `${ch(input.number)} was closed as a duplicate`;
}

/** The digest line (§12.1): with or without the original. */
export function closedAsDuplicateDigestLine(originalNumber: string | number | null): string {
  return originalNumber === null ? "Closed as a duplicate" : `Closed as a duplicate of ${ch(originalNumber)}`;
}

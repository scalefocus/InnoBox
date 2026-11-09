// §41 "This affects me too" — a colleague says a challenge affects them, and how many people it
// affects, themselves included; the authors give the first estimate on the submit form
// (INNOBOX_SPEC.md §41). Pure rules only: the headcount bounds and parsers, the eligibility matrix,
// the reach arithmetic, the SQL fragments every reach number is computed with, and the user-facing
// copy. DB access stays in the caller. Client-safe subpath export (`@innobox/shared/affected`): no
// node deps.
import type { ChallengeStatus } from "./challenges.js";

/** §41 decision 2 — fixed in code, like the §23 weights. */
export const AFFECTED_HEADCOUNT_MIN = 1;
export const AFFECTED_HEADCOUNT_MAX = 1000;
/** §41.5: the Who's affected section shows this many markers before "+N more". */
export const AFFECTED_SHOWN = 12;

// ── Copy (§41.3–§41.6) — user-facing, so no spec references ──────────────────────────────

/** The API's refusals (§41.10). Own, not yet triaged and closed share one message. */
export const AFFECTED_MESSAGES = {
  refused: "You can't mark this challenge as affecting you.",
  invalidHeadcount: "Enter a whole number from 1 to 1,000.",
} as const;

/** The popover's heading and the submit form's label (§41.2, §41.3). */
export const AFFECTED_QUESTION = "How many people does this affect, you included?";
/** The popover's hint (§41.3). */
export const AFFECTED_POPOVER_HINT =
  "Count yourself and colleagues who have the same problem. Everyone who can see this challenge sees your name and number.";
/** The submit form's hint under the authors' estimate (§41.2). */
export const AFFECTED_ESTIMATE_HINT = "Optional — your best guess. Colleagues can add themselves once it has been reviewed.";
/** The button's tooltip once the challenge has closed (§41.3). */
export const AFFECTED_CLOSED_TOOLTIP = "This challenge is closed, so its reach is final.";
/** The one explanation every reach tooltip and info icon shares (§41.4). */
export const REACH_EXPLANATION = "The author's estimate plus what each colleague reported. People in the same team may be counted more than once.";
/** The similar-challenges banner's second line (§41.5). */
export const AFFECTED_BANNER_LINE = "If one of them is your problem, you can say it affects you too instead of submitting.";

/** The button: "This affects me too", or "Affects me · 12" once the viewer has marked it. */
export function affectedButtonLabel(mine: number | null): string {
  return mine === null ? "This affects me too" : `Affects me · ${formatCount(mine)}`;
}

/** A whole number with a thousands separator (1,240) — fixed, whatever the browser's locale. */
export function formatCount(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** §41.4: "About 120 people affected", or "1 person affected". */
export function reachLabel(reach: number): string {
  return reach === 1 ? "1 person affected" : `About ${formatCount(reach)} people affected`;
}

/** §41.5: the breakdown line under the reach. */
export function affectedBreakdown(input: { estimate: number | null; teamSize: number; external: boolean; people: number }): string {
  const team = input.teamSize > 1;
  const head =
    input.estimate !== null
      ? `The ${team ? "authors'" : "author's"} estimate of ${formatCount(input.estimate)}`
      : input.external
        ? "The outside submitter"
        : team
          ? "The authors"
          : "The author";
  if (input.people <= 0) return `${head}.`;
  const who = input.people === 1 ? "1 colleague who says" : `${formatCount(input.people)} colleagues who say`;
  return `${head}, plus ${who} it affects them too.`;
}

/** §41.5: the toast after marking a challenge from the similar-challenges banner. */
export function affectedBannerToast(number: string): string {
  return `Marked ${number} as affecting you. You can still submit yours.`;
}

// ── Event 24 (§41.6) ─────────────────────────────────────────────────────────────────────

/** The inbox/e-mail line. The write path renders the count ≥ 2 text in SQL too (lib/notify.ts
 *  `AFFECTED_MESSAGE_SQL`); a dbtest pins the two together. Markers are public (§41 decision 4), so
 *  naming them is safe; the recipients are the challenge's authors. */
export function affectedNotificationMessage(count: number, challengeNumber: string, latestBy: string): string {
  if (count <= 1) return `${latestBy} says ${challengeNumber} affects them too.`;
  return `${count} people say ${challengeNumber} affects them too — latest ${latestBy}.`;
}

/** The e-mail subject, sent with a person's first mark while the inbox row is unread. */
export function affectedEmailSubject(latestBy: string, challengeNumber: string): string {
  return `${latestBy} says your challenge ${challengeNumber} affects them too`;
}

/** The e-mail's second line: the marker's headcount and the challenge's numbers now. */
export function affectedEmailDetail(input: { headcount: number; challengeNumber: string; title: string; reach: number; people: number }): string {
  const counted = input.headcount === 1 ? "only themselves" : `${formatCount(input.headcount)} people, themselves included`;
  const people = input.people === 1 ? "1 colleague says" : `${formatCount(input.people)} colleagues say`;
  return `They count ${counted}. ${input.challengeNumber} "${input.title}": ${reachLabel(input.reach).toLowerCase()} — ${people} it affects them.`;
}

/** The digest's line for a challenge's coalesced event-24 row (§41.6). */
export function affectedDigestLine(count: number, reach: number | null): string {
  const who = count === 1 ? "1 more person says" : `${formatCount(count)} more people say`;
  return reach !== null && reach > 0 ? `${who} it affects them — about ${formatCount(reach)} in all` : `${who} it affects them`;
}

// ── Parsing (§41.10) ─────────────────────────────────────────────────────────────────────

export type ParsedNumber<T> = { ok: true; value: T } | { ok: false; error: string };

/** A mark's headcount: a JSON whole number from 1 to 1,000. A string, a fraction or null refuse. */
export function parseHeadcount(value: unknown): ParsedNumber<number> {
  if (typeof value !== "number" || !Number.isInteger(value) || value < AFFECTED_HEADCOUNT_MIN || value > AFFECTED_HEADCOUNT_MAX) {
    return { ok: false, error: AFFECTED_MESSAGES.invalidHeadcount };
  }
  return { ok: true, value };
}

/** The authors' estimate: as a headcount, or null for "not given". `undefined` is the caller's
 *  "absent" (keep the current value on an edit) and is not accepted here. */
export function parseAffectedEstimate(value: unknown): ParsedNumber<number | null> {
  if (value === null) return { ok: true, value: null };
  return parseHeadcount(value);
}

// ── Eligibility (§41.3) ──────────────────────────────────────────────────────────────────

const MARKABLE: ReadonlySet<ChallengeStatus> = new Set(["in_review", "needs_improvement", "meeting_scheduled", "valid"]);

/** §41.3 rule 3 — marks may be added, changed or removed only in these statuses. */
export function isAffectedOpen(status: ChallengeStatus): boolean {
  return MARKABLE.has(status);
}

/** Why the viewer cannot mark right now — null means they can. `own` and `not_yet` hide the
 *  button; `closed` disables it (pressed, when the viewer has a mark). */
export type AffectedReason = "own" | "not_yet" | "closed" | null;

export function decideAffected(input: { status: ChallengeStatus; isAuthor: boolean; trashed: boolean }): { canMark: boolean; reason: AffectedReason } {
  if (input.isAuthor) return { canMark: false, reason: "own" };
  if (input.trashed) return { canMark: false, reason: "closed" };
  if (input.status === "awaiting_triage") return { canMark: false, reason: "not_yet" };
  if (!isAffectedOpen(input.status)) return { canMark: false, reason: "closed" };
  return { canMark: true, reason: null };
}

// ── The numbers (§41.4) ──────────────────────────────────────────────────────────────────

/** Reach = the authors' estimate (1 when empty) + every current mark's headcount. */
export function affectedReach(estimate: number | null, headcounts: readonly number[]): number {
  return (estimate ?? 1) + headcounts.reduce((sum, h) => sum + h, 0);
}

/** The reach of `challenges <alias>` in SQL — the twin of `affectedReach`, used by every list,
 *  sort and detail read so none of them can disagree. */
export function challengeReachSql(alias: string): string {
  return `(coalesce(${alias}.affected_estimate, 1) + coalesce((select sum(ca.headcount) from challenge_affected ca
            where ca.challenge_id = ${alias}.id and ca.removed_at is null), 0))::int`;
}

/** The people count of `challenges <alias>` in SQL: its current marks. */
export function challengeAffectedPeopleSql(alias: string): string {
  return `(select count(*) from challenge_affected ca where ca.challenge_id = ${alias}.id and ca.removed_at is null)::int`;
}

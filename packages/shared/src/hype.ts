// §26 Hype — the scarce weekly endorsement beside the unlimited like (INNOBOX_SPEC.md §26).
// Pure rules only: the week boundary, the budget, the early-hype weight, the eligibility
// matrix and the user-facing copy. DB access (budget used, hyped-before, visibility) stays in
// the caller. Client-safe subpath export (`@innobox/shared/hype`): no node deps.
import type { ChallengeStatus, SolutionStatus } from "./challenges.js";

/** §26.2 — fixed in code, like the §23 weights (§26 decision 2). */
export const HYPES_PER_WEEK = 3;
/** §26.4 — a hype inside the item's first 7 days (measured from creation) weighs 2. */
export const HYPE_EARLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const HYPE_EARLY_WEIGHT = 2;
export const HYPE_LATE_WEIGHT = 1;
export type HypeWeight = 1 | 2;
/** §26.5 — the Home board shows this many items. */
export const HYPE_BOARD_SIZE = 5;
/** §26.5 — the hypers list shows this many bubbles before "+N". */
export const HYPERS_SHOWN = 12;
/** §26.7 — daily cap on `hype_received` points per recipient (first N hypes of a UTC day). */
export const HYPE_RECEIVED_DAILY_CAP = 10;

// ── The week (§26.2) ─────────────────────────────────────────────────────────────────────

/** Monday 00:00:00 UTC of the ISO week containing `now`. Local time plays no part. */
export function weekStartUtc(now: Date): Date {
  const daysSinceMonday = (now.getUTCDay() + 6) % 7; // Sunday → 6, Monday → 0
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday));
}

/** The next Monday 00:00:00 UTC — when the budget and the board reset. */
export function nextWeekStartUtc(now: Date): Date {
  const start = weekStartUtc(now);
  return new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
}

/** The budget left this week from the number of hypes already given in it. */
export function hypesLeft(usedThisWeek: number): number {
  return Math.max(0, HYPES_PER_WEEK - Math.max(0, Math.floor(usedThisWeek)));
}

// ── Weight (§26.4) ───────────────────────────────────────────────────────────────────────

/** Fixed at insert time: 2 while `now < createdAt + 7 days`, else 1. Exactly 7 days is late. */
export function hypeWeight(itemCreatedAt: Date, now: Date): HypeWeight {
  return now.getTime() - itemCreatedAt.getTime() < HYPE_EARLY_WINDOW_MS ? HYPE_EARLY_WEIGHT : HYPE_LATE_WEIGHT;
}

// ── Eligibility (§26.3) ──────────────────────────────────────────────────────────────────

const OPEN_CHALLENGE_STATUSES: ReadonlySet<ChallengeStatus> = new Set(["in_review", "needs_improvement", "meeting_scheduled", "valid"]);
const OPEN_SOLUTION_STATUSES: ReadonlySet<SolutionStatus> = new Set([
  "proposed",
  "in_review",
  "needs_improvement",
  "valid",
  "accepted_internally",
  "waiting_for_resources",
  "in_implementation",
  "external_acceptance",
]);

/** §26.3 rule 3 — a challenge is open for hype in these statuses; `awaiting_triage` is not. */
export function isChallengeHypeOpen(status: ChallengeStatus): boolean {
  return OPEN_CHALLENGE_STATUSES.has(status);
}

/** §26.3 rule 3 — a solution is open only while it AND its parent challenge are open: a closed
 *  challenge freezes hype on its solutions exactly as it freezes likes (§8.3). */
export function isSolutionHypeOpen(status: SolutionStatus, challengeStatus: ChallengeStatus): boolean {
  return OPEN_SOLUTION_STATUSES.has(status) && isChallengeHypeOpen(challengeStatus);
}

/** Why the viewer cannot hype right now — `null` means they can. The order is the §26.3 one:
 *  `closed` and `own` hide the button, `hyped` renders it pressed, `budget` disables it. */
export type HypeReason = "closed" | "own" | "hyped" | "budget" | null;

export interface HypeDecisionInput {
  /** §26.3 rule 3 — see isChallengeHypeOpen / isSolutionHypeOpen. */
  open: boolean;
  /** §26.3 rule 4 — the viewer wrote the item (anonymous or not). */
  isAuthor: boolean;
  /** §26.3 rule 5 — the viewer already hyped this item. */
  alreadyHyped: boolean;
  /** §26.3 rule 6 — hypes the viewer has given this week. */
  usedThisWeek: number;
}

export function decideHype(input: HypeDecisionInput): { canHype: boolean; reason: HypeReason } {
  if (!input.open) return { canHype: false, reason: "closed" };
  if (input.isAuthor) return { canHype: false, reason: "own" };
  if (input.alreadyHyped) return { canHype: false, reason: "hyped" };
  if (hypesLeft(input.usedThisWeek) === 0) return { canHype: false, reason: "budget" };
  return { canHype: true, reason: null };
}

// ── Copy (§26.2, §26.4, §26.11) — user-facing, so no spec references ────────────────────

/** The 409 messages the API returns (§26.11). A closed item and the viewer's own item share
 *  one message so the refusal reveals nothing about an anonymous item's authorship. */
export const HYPE_MESSAGES = {
  closed: "Hype is closed for this item",
  own: "Hype is closed for this item",
  hyped: "You've already hyped this",
  budget: "You've used this week's hypes. They reset on Monday.",
} as const;

/** The button's label: "Hype · 2 left this week". */
export function hypeButtonLabel(left: number): string {
  return `Hype · ${left} left this week`;
}

/** The Home board's budget line (§26.5). */
export function hypeBudgetLine(left: number): string {
  if (left <= 0) return "You've used this week's hypes — they reset on Monday";
  return `You have ${left} ${left === 1 ? "hype" : "hypes"} left this week`;
}

/** The button tooltip while it can be pressed (§26.4). */
export function hypeTooltip(early: boolean): string {
  return early ? "Counts double — this item is under a week old" : "Spend one of this week's hypes on this item";
}

/** True while a hype given now would count double (§26.4) — for the tooltip. */
export function isEarlyHype(itemCreatedAt: Date, now: Date): boolean {
  return hypeWeight(itemCreatedAt, now) === HYPE_EARLY_WEIGHT;
}

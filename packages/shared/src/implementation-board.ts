// The implementation board (INNOBOX_SPEC.md §46) — pure and CLIENT-SAFE (also exposed at
// `@innobox/shared/implementation-board` for the page). One page of every accepted solution a
// viewer can see, as a card in the column of its status. This module owns the columns, the limits,
// the query parser the API and the page share, the moves a viewer has on a card, the on-board rule,
// the two column orders, the time-in-stage wording and every string the board shows. The rows, the
// visibility predicate and the status change itself live in the web tier (§8.2 is unchanged).
import type { ChallengeStatus, SolutionStatus } from "./challenges.js";

/** §46.2: the five columns, in board order — one per status from acceptance to implementation. */
export const IMPLEMENTATION_BOARD_COLUMNS = [
  "accepted_internally",
  "waiting_for_resources",
  "in_implementation",
  "external_acceptance",
  "implemented",
] as const satisfies readonly SolutionStatus[];
export type BoardColumn = (typeof IMPLEMENTATION_BOARD_COLUMNS)[number];

/** §46.1: the four columns before *Implemented*. */
export const IN_PROGRESS_COLUMNS = IMPLEMENTATION_BOARD_COLUMNS.slice(0, 4) as readonly BoardColumn[];

/** §46.2: an implemented card stays this many days (90 × 24 hours, judged by the server). */
export const IMPLEMENTATION_BOARD_WINDOW_DAYS = 90;
/** §46.8: an open, visible board re-reads itself this often. */
export const IMPLEMENTATION_BOARD_REFRESH_MS = 30_000;
/** §46.3: a column shows this many cards, then reveals this many more at a time. */
export const IMPLEMENTATION_BOARD_PAGE = 30;
/** §46.3: a read carries at most this many cards per column. */
export const IMPLEMENTATION_BOARD_COLUMN_MAX = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

/** §46.1: the challenge statuses under which a card is on the board. */
const BOARD_CHALLENGE_STATUSES: ReadonlySet<string> = new Set<ChallengeStatus>(["valid", "solved"]);

export function isBoardColumn(status: string): status is BoardColumn {
  return (IMPLEMENTATION_BOARD_COLUMNS as readonly string[]).includes(status);
}

/** The cut-off instant of the 90-day window: an implemented card changed after it is on the board. */
export function implementedWindowStart(now: Date): Date {
  return new Date(now.getTime() - IMPLEMENTATION_BOARD_WINDOW_DAYS * DAY_MS);
}

/**
 * §46.2 rules 1, 2, 3 and 5 — the on-board rule, without rule 4 (who can see the challenge), which
 * is the visibility predicate's. The SQL in the web tier is this rule's twin.
 */
export function isOnBoard(input: {
  solutionStatus: string;
  challengeStatus: string;
  statusChangedAt: Date;
  trashed: boolean;
  challengeTrashed: boolean;
  now: Date;
}): boolean {
  if (!isBoardColumn(input.solutionStatus)) return false;
  if (input.trashed || input.challengeTrashed) return false;
  if (!BOARD_CHALLENGE_STATUSES.has(input.challengeStatus)) return false;
  if (input.solutionStatus === "implemented") return input.statusChangedAt.getTime() > implementedWindowStart(input.now).getTime();
  return true;
}

// ── Moves (§46.6) ────────────────────────────────────────────────────────────────────────

/** `override` for a platform or namespace admin, `enforced` for a committee member or the assignee. */
export type BoardMoveMode = "override" | "enforced";

/** The §8.2 arrows inside the board — the committee's and the assignee's moves, `rejected` left out. */
const ENFORCED_BOARD_MOVES: Record<BoardColumn, readonly BoardColumn[]> = {
  accepted_internally: ["waiting_for_resources"],
  waiting_for_resources: ["in_implementation"],
  in_implementation: ["external_acceptance", "implemented"],
  external_acceptance: ["implemented"],
  implemented: [],
};

/**
 * §46.6: the columns a viewer may move a card to, in board order, and the mode — or no moves.
 * `isAdmin` is a platform admin or a namespace admin of the challenge's namespace; `isEnforcer` is
 * a committee member of that namespace who is not an author of the solution, or the challenge's
 * assignee (`isReviewEnforcer`, §39.5). An admin who is also an enforcer gets the admin's list.
 */
export function boardMoves(input: { status: string; isAdmin: boolean; isEnforcer: boolean }): { moves: BoardColumn[]; mode: BoardMoveMode | null } {
  if (!isBoardColumn(input.status) || input.status === "implemented") return { moves: [], mode: null };
  if (input.isAdmin) {
    const moves = IMPLEMENTATION_BOARD_COLUMNS.filter((c) => c !== input.status);
    return { moves, mode: "override" };
  }
  if (input.isEnforcer) {
    const moves = [...ENFORCED_BOARD_MOVES[input.status]];
    return moves.length > 0 ? { moves, mode: "enforced" } : { moves: [], mode: null };
  }
  return { moves: [], mode: null };
}

// ── Order (§46.2) ────────────────────────────────────────────────────────────────────────

export interface BoardOrderKey {
  status: string;
  statusChangedAt: Date | string;
  /** The bare solution number. */
  number: number | string;
}

const time = (v: Date | string): number => (v instanceof Date ? v.getTime() : Date.parse(v));
const num = (v: number | string): number => Number(String(v).replace(/\D/g, ""));

/**
 * §46.2: in-progress columns — `status_changed_at` ascending (the longest wait first), then the lower
 * number; *Implemented* — `status_changed_at` descending, then the higher number. Both cards are in
 * the same column.
 */
export function compareBoardCards(a: BoardOrderKey, b: BoardOrderKey): number {
  const newestFirst = a.status === "implemented";
  const dt = time(a.statusChangedAt) - time(b.statusChangedAt);
  if (dt !== 0) return newestFirst ? -dt : dt;
  const dn = num(a.number) - num(b.number);
  return newestFirst ? -dn : dn;
}

// ── The query (§46.5) ────────────────────────────────────────────────────────────────────

export interface BoardFilters {
  namespaceId?: string;
  impactAreaId?: string;
  topicId?: string;
  involving: boolean;
  following: boolean;
}

/** The five address and query parameters, as the page and the API name them. */
export const BOARD_PARAMS = {
  namespace: "namespaceId",
  impactArea: "impactAreaId",
  topic: "topic",
  involving: "involving",
  following: "following",
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BoardQueryResult = { ok: true; value: BoardFilters } | { ok: false; error: string; param: string };

/** Something with a `get` that reads the FIRST occurrence of a parameter — URLSearchParams does. */
interface ParamReader {
  get(name: string): string | null;
}

/**
 * §46.5 One parser: an id is malformed when it is not a UUID (the empty string included); a toggle
 * when its value is anything but `1`. The first occurrence of a repeated parameter is read, and
 * unknown parameters are ignored. The API answers 400 on a malformed one; the page drops it first.
 */
export function parseBoardQuery(params: ParamReader): BoardQueryResult {
  const value: BoardFilters = { involving: false, following: false };
  const ids: [keyof BoardFilters, string][] = [
    ["namespaceId", BOARD_PARAMS.namespace],
    ["impactAreaId", BOARD_PARAMS.impactArea],
    ["topicId", BOARD_PARAMS.topic],
  ];
  for (const [key, name] of ids) {
    const raw = params.get(name);
    if (raw === null) continue;
    if (!UUID.test(raw)) return { ok: false, error: `${name} must be an id`, param: name };
    (value as unknown as Record<string, string>)[key] = raw.toLowerCase();
  }
  for (const name of [BOARD_PARAMS.involving, BOARD_PARAMS.following] as const) {
    const raw = params.get(name);
    if (raw === null) continue;
    if (raw !== "1") return { ok: false, error: `${name} must be 1`, param: name };
    value[name] = true;
  }
  return { ok: true, value };
}

/**
 * §46.5 In the URL: the page's own first check — every malformed value is dropped before it reads, so
 * it never sends one. Returns what is left and the parameter names it dropped.
 */
export function sanitizeBoardQuery(params: ParamReader): { filters: BoardFilters; dropped: string[] } {
  const dropped: string[] = [];
  const copy = new Map<string, string>();
  for (const name of Object.values(BOARD_PARAMS)) {
    const raw = params.get(name);
    if (raw !== null) copy.set(name, raw);
  }
  for (;;) {
    const parsed = parseBoardQuery({ get: (n) => copy.get(n) ?? null });
    if (parsed.ok) return { filters: parsed.value, dropped };
    copy.delete(parsed.param);
    dropped.push(parsed.param);
  }
}

/** The query string for a set of filters — absent values and off toggles are left out. */
export function boardQueryString(filters: BoardFilters): string {
  const out = new URLSearchParams();
  if (filters.namespaceId) out.set(BOARD_PARAMS.namespace, filters.namespaceId);
  if (filters.impactAreaId) out.set(BOARD_PARAMS.impactArea, filters.impactAreaId);
  if (filters.topicId) out.set(BOARD_PARAMS.topic, filters.topicId);
  if (filters.involving) out.set(BOARD_PARAMS.involving, "1");
  if (filters.following) out.set(BOARD_PARAMS.following, "1");
  return out.toString();
}

export function hasBoardFilters(filters: BoardFilters): boolean {
  return Boolean(filters.namespaceId || filters.impactAreaId || filters.topicId || filters.involving || filters.following);
}

// ── Long columns (§46.3) ─────────────────────────────────────────────────────────────────

/** How many cards a column shows once it must show the card at `index` (0-based): whole pages. */
export function showingToInclude(index: number, showing: number): number {
  if (index < showing) return showing;
  return Math.ceil((index + 1) / IMPLEMENTATION_BOARD_PAGE) * IMPLEMENTATION_BOARD_PAGE;
}

/** The **Show more** button's count: the loaded cards not yet showing, a page at most; 0 → no button. */
export function showMoreCount(loaded: number, showing: number): number {
  return Math.max(0, Math.min(IMPLEMENTATION_BOARD_PAGE, loaded - showing));
}

// ── Copy (§46.3, §46.4, §46.7, §46.8) ────────────────────────────────────────────────────

const digitsOf = (n: string | number): string => String(n).replace(/\D/g, "");

/** §46.4: whole 24-hour periods between the last status change and `now`; under one, a negative
 *  difference included, reads "Less than a day". `now` is an argument: the text is worked out when a
 *  read lands, never between reads. */
export function timeInStageText(statusChangedAt: Date | string, now: Date): string {
  const days = Math.floor((now.getTime() - time(statusChangedAt)) / DAY_MS);
  if (days < 1) return "Less than a day in this stage";
  return days === 1 ? "1 day in this stage" : `${days} days in this stage`;
}

/** §46.7: the confirmation before a move into *Implemented* — its second wording when the
 *  challenge is already solved (§46.2). */
export function implementedConfirmText(solutionNumber: string | number, challengeNumber: string | number, challengeAlreadySolved: boolean): string {
  const sol = `SOL-${digitsOf(solutionNumber)}`;
  const ch = `CH-${digitsOf(challengeNumber)}`;
  return challengeAlreadySolved
    ? `Mark ${sol} as implemented? ${ch} is already solved. This closes its other open solutions as not selected and tells the people involved. It can't be undone from the board.`
    : `Mark ${sol} as implemented? This solves ${ch}, closes its other open solutions as not selected and tells the people involved. It can't be undone from the board.`;
}

/** §46.7: the polite live region after the viewer's own move. */
export function movedAnnouncement(solutionNumber: string | number, columnLabel: string, beyondCap = false): string {
  const base = `SOL-${digitsOf(solutionNumber)} moved to ${columnLabel}.`;
  return beyondCap ? `${base} It is below the first ${IMPLEMENTATION_BOARD_COLUMN_MAX} cards of that column.` : base;
}

/** §46.3: the line under a column that holds more than a read carries. */
export function columnCapLine(total: number): string {
  return `Showing ${IMPLEMENTATION_BOARD_COLUMN_MAX} of ${total}. Use the filters to narrow the board.`;
}

/** §46.3: the button that reveals loaded cards. */
export function showMoreLabel(count: number): string {
  return `Show ${count} more`;
}

/** §46.5: the extra, selected Topic option while a retired topic is the filter. */
export function retiredTopicOption(name: string): string {
  return `${name} (retired)`;
}

/** §46.4: the like and hype labels say whose numbers they are. */
export function solutionLikesLabel(count: number): string {
  return count === 1 ? "1 like on this solution" : `${count} likes on this solution`;
}
export function solutionHypeLabel(points: number): string {
  return `${points} hype on this solution`;
}

/** §46.8 What the mover sees: which of the three toasts an answer gets, and whether it re-reads. */
export type MoveRefusal = "changed" | "no_longer_yours" | "signed_out" | "not_saved";

export function classifyMoveAnswer(status: number): { refusal: MoveRefusal; reread: boolean } {
  if (status === 404 || status === 409) return { refusal: "changed", reread: true };
  if (status === 403 || status === 422) return { refusal: "no_longer_yours", reread: true };
  if (status === 401) return { refusal: "signed_out", reread: false };
  return { refusal: "not_saved", reread: false };
}

export const BOARD_COPY = {
  title: "Implementation board",
  subtitle: "Accepted solutions on their way to implementation.",
  navLabel: "Implementation",
  homeLink: "See the implementation board",
  quickStartSentence: "Implementation shows every accepted solution on its way to being built.",
  implementedNote: "Implemented in the last 90 days. Older ones stay on their challenges; the solved ones are under",
  implementedNoteLink: "Challenges → Completed",
  emptyColumn: "Nothing here.",
  emptyBoard: "Nothing is on the board right now. A solution appears here once it is accepted.",
  noMatch: "No cards match these filters.",
  clearFilters: "Clear filters",
  loading: "Loading the board…",
  loadFailed: "The board didn't load.",
  loadFailedToast: "The board didn't load. Please try again.",
  tryAgain: "Try again",
  moveTo: "Move to…",
  unassigned: "Unassigned",
  allNamespaces: "All namespaces",
  allImpactAreas: "All impact areas",
  allTopics: "All topics",
  involvingMe: "Involving me",
  following: "Following",
  changedToast: "That card changed while you were looking at it. The board is up to date now.",
  noLongerYoursToast: "You can no longer move this card.",
  notSavedToast: "That didn't save. Please try again.",
  /** §46.8: the API's 409 for an out-of-date card (the board shows its own toast instead). */
  staleStatus: "This solution has changed since you loaded it. Reload to see where it stands.",
} as const;

/** §46.4: the assignee bubble's label. */
export function assignedToLabel(name: string): string {
  return `Assigned to ${name}`;
}

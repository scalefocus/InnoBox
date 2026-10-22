// §39 Co-authors — a challenge or a solution written by a team of up to five (INNOBOX_SPEC.md
// §39). Pure rules only: the size cap, the joining window, the coAuthorIds and baseEditedAt
// parsers, the team-change decision in the §39.13 refusal order, the masked team projection, its
// compact and text forms, and the join replay set. DB access (members, eligibility, awards) stays
// in the caller. Client-safe subpath export (`@innobox/shared/coauthors`): no node deps.
import type { MaskedAuthor } from "./challenges.js";

/** §39.2 decision 4: the creator plus four. */
export const TEAM_MAX = 5;
/** §6.1, §6.2: the co-authors a submit form takes besides the creator. */
export const CO_AUTHORS_MAX = TEAM_MAX - 1;
/** §39.7: the small bubbles stacked after the first member's name in the compact form. */
export const COMPACT_BUBBLES_MAX = 3;

/** The user-facing refusals (§39.2–§39.5, §7.2). */
export const TEAM_MESSAGES = {
  anonymousCreate: "Anonymous items can't have co-authors.",
  anonymousAdd: "Anonymous items can't have co-authors. Reveal yourself as the author first.",
  notMember: "Only the item's authors can change its team.",
  closed: "This team can no longer change.",
  full: "A team can have at most five people.",
  creator: "The creator can only leave on their own.",
  lastMember: "You're the only author, so you can't leave.",
  ineligible: "This person can't be added to this team.",
  staleEdit: "Someone else edited this since you opened it. Reload to see their changes.",
  ownItemReview: "You can't review an item you're an author of.",
} as const;

/** §13.1: the line a committee member sees in place of the transition control on their own item. */
export const OWN_ITEM_REVIEW_HINT = "You're an author of this item, so another reviewer moves it.";

export type TeamEntity = "challenge" | "solution";

const SOLUTION_JOINING_OPEN = new Set(["proposed", "in_review", "needs_improvement", "valid"]);
const CHALLENGE_JOINING_OPEN = new Set(["awaiting_triage", "in_review", "needs_improvement", "meeting_scheduled", "valid"]);

/** §39.4: a solution's team changes until it moves past `valid`; a challenge's in any non-terminal
 *  status. An admin override back into one of these statuses opens it again — the status alone
 *  decides. */
export function isJoiningOpen(entity: TeamEntity, status: string): boolean {
  return entity === "solution" ? SOLUTION_JOINING_OPEN.has(status) : CHALLENGE_JOINING_OPEN.has(status);
}

/** True when `userId` is on the team (`authorIds` are the member rows, §39.2). */
export function isTeamMember(authorIds: readonly string[], userId: string): boolean {
  return authorIds.includes(userId);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TeamResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** §39.13: a create's `coAuthorIds` — absent means none; otherwise at most four distinct user ids,
 *  never the caller. A malformed list is a 400 (eligibility, a 422, is the caller's). */
export function parseCoAuthorIds(raw: unknown, callerId: string): TeamResult<string[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw) || !raw.every((id) => typeof id === "string" && UUID_RE.test(id))) {
    return { ok: false, error: "coAuthorIds must be a list of user ids" };
  }
  const ids = raw.map((id: string) => id.toLowerCase());
  if (new Set(ids).size !== ids.length) return { ok: false, error: "coAuthorIds must not repeat a person" };
  if (ids.length > CO_AUTHORS_MAX) return { ok: false, error: `An item can have at most ${CO_AUTHORS_MAX} co-authors.` };
  if (ids.includes(callerId.toLowerCase())) return { ok: false, error: "coAuthorIds must not include you" };
  return { ok: true, value: ids };
}

/** §39.5: the `editedAt` the editor loaded — `null` for an item never edited, an ISO time otherwise.
 *  Required on every content edit; absent or malformed is a 400. */
export function parseBaseEditedAt(raw: unknown): TeamResult<string | null> {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string" || raw === "" || Number.isNaN(new Date(raw).getTime())) {
    return { ok: false, error: "baseEditedAt is required" };
  }
  return { ok: true, value: new Date(raw).toISOString() };
}

/** §39.13: why a team change is refused, in the order the API checks them after the 404. */
export type TeamRefusal = "not_member" | "anonymous" | "closed" | "full" | "creator" | "last_member" | "ineligible";

/** The HTTP status of each refusal (§39.13: 403, then 409, then 422). */
export const TEAM_REFUSAL_STATUS: Record<TeamRefusal, 403 | 409 | 422> = {
  not_member: 403,
  anonymous: 409,
  closed: 409,
  full: 409,
  creator: 409,
  last_member: 409,
  ineligible: 422,
};

/** The message of each refusal. */
export const TEAM_REFUSAL_MESSAGE: Record<TeamRefusal, string> = {
  not_member: TEAM_MESSAGES.notMember,
  anonymous: TEAM_MESSAGES.anonymousAdd,
  closed: TEAM_MESSAGES.closed,
  full: TEAM_MESSAGES.full,
  creator: TEAM_MESSAGES.creator,
  last_member: TEAM_MESSAGES.lastMember,
  ineligible: TEAM_MESSAGES.ineligible,
};

export type TeamChange =
  /** `eligible`: §39.2 — active, not erased, not a member, never left, can see the item. */
  | { op: "add"; eligible: boolean }
  /** Removing someone else. `targetIsCreator` / `targetErased` drive the creator's protection. */
  | { op: "remove"; targetIsCreator: boolean; targetErased: boolean }
  | { op: "leave" };

/**
 * §39.4 / §39.13: may the caller make this team change? The caller has already answered 404 for an
 * item they cannot see, a malformed number or a trashed item. Then: 403 for a non-member; 409 for an
 * anonymous item (adds), a closed window (adding and removing others only — leaving works in any
 * status), the cap (adds), the creator (removals, until they are erased) and the last member (leaves);
 * then 422 for an ineligible person.
 */
export function decideTeamChange(
  input: { callerIsMember: boolean; isAnonymous: boolean; joiningOpen: boolean; teamSize: number } & { change: TeamChange },
): { ok: true } | { ok: false; refusal: TeamRefusal } {
  const refuse = (refusal: TeamRefusal) => ({ ok: false as const, refusal });
  if (!input.callerIsMember) return refuse("not_member");
  const change = input.change;
  if (change.op === "leave") return input.teamSize <= 1 ? refuse("last_member") : { ok: true };
  if (change.op === "add") {
    if (input.isAnonymous) return refuse("anonymous");
    if (!input.joiningOpen) return refuse("closed");
    if (input.teamSize >= TEAM_MAX) return refuse("full");
    return change.eligible ? { ok: true } : refuse("ineligible");
  }
  if (!input.joiningOpen) return refuse("closed");
  if (change.targetIsCreator && !change.targetErased) return refuse("creator");
  return { ok: true };
}

/**
 * §39.5 / §7.2 / §8.2: may this viewer make ENFORCED transitions on the item? A committee member of
 * the namespace may — never on an item they are an author of (decision 20, solo authors included);
 * the challenge's assignee may, whether or not they are an author. Admins free-set instead.
 */
export function isReviewEnforcer(input: { isCommittee: boolean; isAssignee: boolean; isAuthor: boolean }): boolean {
  return (input.isCommittee && !input.isAuthor) || input.isAssignee;
}

/** True when the committee bar is the only thing keeping this viewer from reviewing — the 403
 *  that names it rather than the generic refusal (§39.5). */
export function isBarredAsAuthor(input: { isCommittee: boolean; isAssignee: boolean; isAuthor: boolean }): boolean {
  return input.isCommittee && input.isAuthor && !input.isAssignee;
}

// ── The team as a payload (§39.7) ─────────────────────────────────────────────────────────

/** One member as the read paths select it (`authors` JSON, ordered by `added_at`, then user id). */
export interface TeamMemberRow {
  id: string;
  displayName: string | null;
  active: boolean | null;
  scrubbed: boolean | null;
  /** The item's creator (`author_id`). */
  creator?: boolean;
}

/** A detail-payload member: the masked shape plus the Team panel's `creator` flag (§39.7). */
export type TeamAuthor = MaskedAuthor & { creator?: boolean };

/**
 * §39.7 `authors`: the ordered members, masked. An anonymous item is the single anonymous shape
 * whatever its rows say (it has exactly one member, §39.3), and an external challenge (§24.6) the
 * single "External submission" shape — `single` is that one masked author, built by the caller's
 * `maskAuthor`. With `creatorFlag`, each named member carries `creator` (the detail payload only).
 */
export function maskTeam(single: MaskedAuthor, members: readonly TeamMemberRow[], opts: { creatorFlag?: boolean } = {}): TeamAuthor[] {
  if (single.anonymous || single.external || members.length === 0) return [single];
  return members.map((m) => ({
    userId: m.id,
    displayName: m.displayName ?? "",
    anonymous: false,
    active: m.active ?? true,
    scrubbed: m.scrubbed ?? false,
    ...(opts.creatorFlag ? { creator: m.creator === true } : {}),
  }));
}

/** §39.7: the compact form's `aria-label` — "Ana Petrova and 2 co-authors". */
export function teamAriaLabel(authors: readonly Pick<MaskedAuthor, "displayName">[]): string {
  const first = authors[0]?.displayName ?? "";
  const more = authors.length - 1;
  if (more <= 0) return first;
  return `${first} and ${more} ${more === 1 ? "co-author" : "co-authors"}`;
}

/** §39.7: e-mail and inbox copy names the first member plus "and N others". */
export function teamText(authors: readonly Pick<MaskedAuthor, "displayName">[]): string {
  const first = authors[0]?.displayName ?? "";
  const more = authors.length - 1;
  if (more <= 0) return first;
  return `${first} and ${more} ${more === 1 ? "other" : "others"}`;
}

/** §14.1: the CSV author cell — every member in order, separated by "; ". */
export function teamCsvCell(authors: readonly Pick<MaskedAuthor, "displayName">[]): string {
  return authors.map((a) => a.displayName).join("; ");
}

// ── Event 21 (§39.8) ──────────────────────────────────────────────────────────────────────

/** "Ana Petrova added you as a co-author of SOL-34" / "… removed you as …". */
export function teamChangeMessage(actorName: string, change: "added" | "removed", itemNumber: string): string {
  return `${actorName} ${change} you as a co-author of ${itemNumber}`;
}

// ── Points (§39.9) ────────────────────────────────────────────────────────────────────────

/**
 * §39.9: the milestones a member who joins now is written, each dated to the join — a challenge's
 * `challenge_submitted`, plus `challenge_validated` once it has entered `valid`; a solution's
 * `solution_proposed`, plus `solution_validated` once it has entered `valid`. Nobody joins after the
 * window closes, so no `*_solved` or `*_implemented` award is ever replayed.
 */
export function joinReplayReasons(
  entity: TeamEntity,
  reached: { validated: boolean },
): ("challenge_submitted" | "challenge_validated" | "solution_proposed" | "solution_validated")[] {
  if (entity === "challenge") return reached.validated ? ["challenge_submitted", "challenge_validated"] : ["challenge_submitted"];
  return reached.validated ? ["solution_proposed", "solution_validated"] : ["solution_proposed"];
}

/** §39.9 leaderboard: a member's contribution time is the later of the event's time and their join. */
export function contributionTime(eventAt: Date, addedAt: Date): Date {
  return eventAt.getTime() >= addedAt.getTime() ? eventAt : addedAt;
}

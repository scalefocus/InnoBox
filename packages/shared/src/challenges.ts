// Challenge/solution domain logic (INNOBOX_SPEC.md §5-§9, §13.1 first slice): status
// vocab, field validation, total anonymity masking (invariant 3), visibility gates
// (§4.3, invariant 2), and the §8.3 single-accepted-solution gate + auto-close helpers.
// Pure and dependency-free — DB access and HTTP concerns stay in the caller.
import type { RoleSet } from "./rbac.js";

export const CHALLENGE_STATUSES = [
  "awaiting_triage",
  "in_review",
  "needs_improvement",
  "meeting_scheduled",
  "valid",
  "solved",
  "rejected",
  "withdrawn",
] as const;
export type ChallengeStatus = (typeof CHALLENGE_STATUSES)[number];

export const SOLUTION_STATUSES = [
  "proposed",
  "in_review",
  "needs_improvement",
  "valid",
  "accepted_internally",
  "waiting_for_resources",
  "in_implementation",
  "external_acceptance",
  "implemented",
  "rejected",
  "not_selected",
  "withdrawn",
] as const;
export type SolutionStatus = (typeof SOLUTION_STATUSES)[number];

/** Display-only prefix (§1.1) — the DB stores the bare number; deep links (§12.1) use it too. */
export function formatChallengeNumber(number: string | number): string {
  return `CH-${number}`;
}

export function formatSolutionNumber(number: string | number): string {
  return `SOL-${number}`;
}

export function isChallengeStatus(value: string): value is ChallengeStatus {
  return (CHALLENGE_STATUSES as readonly string[]).includes(value);
}

export function isSolutionStatus(value: string): value is SolutionStatus {
  return (SOLUTION_STATUSES as readonly string[]).includes(value);
}

// §8.3: statuses at or past accepted_internally — the single-winner gate blocks a
// second solution from entering this set while a sibling already occupies it.
const ACCEPTED_OR_LATER = new Set<SolutionStatus>([
  "accepted_internally",
  "waiting_for_resources",
  "in_implementation",
  "external_acceptance",
  "implemented",
]);

// §8.3 auto-close: these solution statuses are terminal and never get swept into
// not_selected when a sibling is implemented.
const TERMINAL_SOLUTION_STATUSES = new Set<SolutionStatus>([
  "implemented",
  "rejected",
  "not_selected",
  "withdrawn",
]);

export const CHALLENGE_TERMINAL_STATUSES: ReadonlySet<ChallengeStatus> = new Set(["solved", "rejected", "withdrawn"]);

// ── Anonymity masking (§9, invariant 3) ─────────────────────────────────────────────────

export interface MaskedAuthor {
  /** The author's user id — the key for their avatar bubble (§13.6). **Null when anonymous**:
   *  this is the single anonymity-safe gate (invariant 3), so the client never learns an
   *  anonymous author's id and cannot request their photo or fingerprint them by color. */
  userId: string | null;
  displayName: string;
  anonymous: boolean;
}

/** Masking is total by default: an anonymous item shows "Anonymous" (and null userId, so no
 *  avatar/photo) to EVERY viewer, no exceptions — not even the author's own view, not admins,
 *  not committee. The audited admin reveal (§9) is a separate, transient path that never flows
 *  through this projection. */
export function maskAuthor(item: { isAnonymous: boolean; authorId: string; authorDisplayName: string }): MaskedAuthor {
  if (item.isAnonymous) return { userId: null, displayName: "Anonymous", anonymous: true };
  return { userId: item.authorId, displayName: item.authorDisplayName, anonymous: false };
}

// ── Visibility (§4.3, invariant 2) ──────────────────────────────────────────────────────

export interface ViewerContext {
  userId: string;
  roles: RoleSet;
}

export interface ChallengeVisibilityInput {
  namespaceId: string;
  visibility: "org" | "namespace";
  status: ChallengeStatus;
  authorId: string;
}

/** §4.3: awaiting_triage/withdrawn are visible only to their author and the
 *  namespace's admins (platform admins included, via isNamespaceAdmin); otherwise
 *  org-visibility is open to everyone and namespace-visibility is member-only. */
export function canSeeChallenge(viewer: ViewerContext, challenge: ChallengeVisibilityInput): boolean {
  const isAuthor = viewer.userId === challenge.authorId;
  const isNamespaceAdminHere = viewer.roles.isNamespaceAdmin(challenge.namespaceId);
  if (challenge.status === "awaiting_triage" || challenge.status === "withdrawn") {
    return isAuthor || isNamespaceAdminHere;
  }
  if (challenge.visibility === "namespace") {
    return viewer.roles.isMemberOf(challenge.namespaceId);
  }
  return true;
}

export interface SolutionVisibilityInput {
  status: SolutionStatus;
  authorId: string;
}

/** §4.3: a solution inherits its parent challenge's visibility gate, and while
 *  `proposed` is additionally hidden except to its author, the challenge's assignee,
 *  and the namespace's committee/admins. Callers must have already resolved
 *  `canSeeChallenge` for the parent — this only applies the solution-specific narrowing. */
export function canSeeSolution(
  viewer: ViewerContext,
  challenge: { namespaceId: string; assigneeId: string | null },
  solution: SolutionVisibilityInput,
): boolean {
  if (solution.status !== "proposed") return true;
  const isAuthor = viewer.userId === solution.authorId;
  const isAssignee = challenge.assigneeId !== null && viewer.userId === challenge.assigneeId;
  const isCommitteeOrAdmin =
    viewer.roles.isCommittee(challenge.namespaceId) || viewer.roles.isNamespaceAdmin(challenge.namespaceId);
  return isAuthor || isAssignee || isCommitteeOrAdmin;
}

// ── §8.3 single accepted solution & auto-close ──────────────────────────────────────────

/** True when a sibling solution already occupies accepted_internally-or-later — the
 *  gate refusing `valid → accepted_internally` (enforced AND admin override alike). */
export function blocksAcceptedInternally(siblingStatuses: SolutionStatus[]): boolean {
  return siblingStatuses.some((s) => ACCEPTED_OR_LATER.has(s));
}

/** On a solution becoming `implemented`: every OTHER non-terminal sibling of the same
 *  challenge becomes `not_selected`. Returns just the ids that need the update. */
export function siblingsToAutoClose(
  solutions: { id: string; status: SolutionStatus }[],
  implementedSolutionId: string,
): string[] {
  return solutions
    .filter((s) => s.id !== implementedSolutionId && !TERMINAL_SOLUTION_STATUSES.has(s.status))
    .map((s) => s.id);
}

// ── §7.2/§8.2 enforced state machine (committee & assignee) ──────────────────────────────
// The arrows a committee member (of the namespace) or the challenge's assignee may traverse.
// Namespace/platform admins are NOT constrained by these graphs — they free-set any status
// (invariant 6); that role gate lives in the store, not here. Per §7.2, challenge triage
// (leaving `awaiting_triage`) and `valid → solved` are admin/automatic only, so they are
// absent from the committee/assignee graph below. Solutions (§8.2) have no admin-only triage
// step, so `proposed → in_review|rejected` IS available to committee/assignee.

const CHALLENGE_ENFORCED_TRANSITIONS: Record<ChallengeStatus, readonly ChallengeStatus[]> = {
  awaiting_triage: [], // triage is a namespace-admin action (§7.2)
  in_review: ["valid", "needs_improvement", "meeting_scheduled", "rejected"],
  meeting_scheduled: ["in_review", "valid", "needs_improvement", "rejected"],
  needs_improvement: ["in_review"],
  valid: [], // valid → solved is automatic (§8.3) / admin-override only
  solved: [],
  rejected: [],
  withdrawn: [],
};

const SOLUTION_ENFORCED_TRANSITIONS: Record<SolutionStatus, readonly SolutionStatus[]> = {
  proposed: ["in_review", "rejected"],
  in_review: ["valid", "needs_improvement", "rejected"],
  needs_improvement: ["in_review"],
  valid: ["accepted_internally"], // subject to the §8.3 single-winner gate (enforced in the store)
  accepted_internally: ["waiting_for_resources", "rejected"],
  waiting_for_resources: ["in_implementation", "rejected"],
  in_implementation: ["external_acceptance", "implemented", "rejected"],
  external_acceptance: ["implemented", "rejected"],
  implemented: [],
  rejected: [],
  not_selected: [],
  withdrawn: [],
};

/** The legal enforced next-statuses for a committee member / assignee from `from` (§7.2). */
export function challengeEnforcedTargets(from: ChallengeStatus): ChallengeStatus[] {
  return [...(CHALLENGE_ENFORCED_TRANSITIONS[from] ?? [])];
}

/** The legal enforced next-statuses for a committee member / assignee from `from` (§8.2). */
export function solutionEnforcedTargets(from: SolutionStatus): SolutionStatus[] {
  return [...(SOLUTION_ENFORCED_TRANSITIONS[from] ?? [])];
}

export function isChallengeEnforcedTransition(from: ChallengeStatus, to: ChallengeStatus): boolean {
  return (CHALLENGE_ENFORCED_TRANSITIONS[from] ?? []).includes(to);
}

export function isSolutionEnforcedTransition(from: SolutionStatus, to: SolutionStatus): boolean {
  return (SOLUTION_ENFORCED_TRANSITIONS[from] ?? []).includes(to);
}

export type TransitionMode = "override" | "enforced";

export type TransitionDecision =
  | { allowed: true; mode: TransitionMode; changed: boolean }
  | { allowed: false; reason: "forbidden" | "illegal_transition" };

/** Pure authorization for a status transition, shared by challenges and solutions (§7.2/§8.2,
 *  invariant 6). The caller resolves the three capability booleans and whether the requested
 *  target is a legal enforced arrow from the current status:
 *  - `isAdmin`    — namespace/platform admin: free-sets any status (`override`), unconstrained.
 *  - `isEnforcer` — committee member of the namespace, OR the challenge's assignee.
 *  - `isLegalArrow` — target ∈ the enforced graph's arrows out of the current status.
 *  A same-status request (`from === to`) is an idempotent no-op for any authorized actor. */
export function decideTransition(input: {
  from: string;
  to: string;
  isAdmin: boolean;
  isEnforcer: boolean;
  isLegalArrow: boolean;
}): TransitionDecision {
  if (!input.isAdmin && !input.isEnforcer) return { allowed: false, reason: "forbidden" };
  const changed = input.from !== input.to;
  if (!changed) return { allowed: true, mode: input.isAdmin ? "override" : "enforced", changed: false };
  if (input.isAdmin) return { allowed: true, mode: "override", changed: true };
  // enforcer on a real change: must be a legal arrow
  if (!input.isLegalArrow) return { allowed: false, reason: "illegal_transition" };
  return { allowed: true, mode: "enforced", changed: true };
}

// ── §10.1 author edit / withdraw / resubmit windows ──────────────────────────────────────
// Pure predicates: the author may edit content only within these status windows, resubmit
// only from needs_improvement, and withdraw from any non-terminal status.

/** A challenge is author-editable while awaiting_triage, and again once needs_improvement. */
export function canAuthorEditChallenge(status: ChallengeStatus): boolean {
  return status === "awaiting_triage" || status === "needs_improvement";
}

/** A solution is author-editable while proposed, and again once needs_improvement. */
export function canAuthorEditSolution(status: SolutionStatus): boolean {
  return status === "proposed" || status === "needs_improvement";
}

/** Resubmit (→ in_review) is available to the author only from needs_improvement — same
 *  status name on both entities, so one predicate serves both. */
export function canAuthorResubmit(status: ChallengeStatus | SolutionStatus): boolean {
  return status === "needs_improvement";
}

/** The author may withdraw from any non-terminal status (§10.1). */
export function canAuthorWithdrawChallenge(status: ChallengeStatus): boolean {
  return !CHALLENGE_TERMINAL_STATUSES.has(status);
}

export function canAuthorWithdrawSolution(status: SolutionStatus): boolean {
  return !TERMINAL_SOLUTION_STATUSES.has(status);
}

// ── Field validation (mirrors client-side UX; server is authoritative) ─────────────────

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 10_000;
const COST_VS_BENEFITS_MAX = 5_000;

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export interface ValidatedChallengeFields {
  title: string;
  description: string;
  clientName: string | null;
  visibility: "org" | "namespace";
  isAnonymous: boolean;
}

/** `impactAreaIsClient` is resolved by the caller (a DB lookup of the chosen impact
 *  area's name) — this function stays pure and just applies the §5 pairing rule. */
export function validateChallengeFields(input: {
  title: unknown;
  description: unknown;
  clientName: unknown;
  visibility: unknown;
  isAnonymous: unknown;
  impactAreaIsClient: boolean;
}): Result<ValidatedChallengeFields> {
  if (typeof input.title !== "string" || input.title.trim() === "") {
    return fail("title is required");
  }
  const title = input.title.trim();
  if (title.length > TITLE_MAX) return fail(`title must be at most ${TITLE_MAX} characters`);

  if (typeof input.description !== "string" || input.description.trim() === "") {
    return fail("description is required");
  }
  const description = input.description.trim();
  if (description.length > DESCRIPTION_MAX) {
    return fail(`description must be at most ${DESCRIPTION_MAX} characters`);
  }

  if (input.visibility !== "org" && input.visibility !== "namespace") {
    return fail("visibility must be 'org' or 'namespace'");
  }

  if (typeof input.isAnonymous !== "boolean") return fail("isAnonymous must be a boolean");

  let clientName: string | null = null;
  const rawClientName = typeof input.clientName === "string" ? input.clientName.trim() : "";
  if (input.impactAreaIsClient) {
    if (rawClientName === "") return fail("clientName is required when impact area is Client");
    clientName = rawClientName;
  } else if (rawClientName !== "") {
    return fail("clientName must be empty unless impact area is Client");
  }

  return { ok: true, value: { title, description, clientName, visibility: input.visibility, isAnonymous: input.isAnonymous } };
}

export interface ValidatedSolutionFields {
  description: string;
  costVsBenefits: string | null;
  isAnonymous: boolean;
}

export function validateSolutionFields(input: {
  description: unknown;
  costVsBenefits: unknown;
  isAnonymous: unknown;
}): Result<ValidatedSolutionFields> {
  if (typeof input.description !== "string" || input.description.trim() === "") {
    return fail("description is required");
  }
  const description = input.description.trim();
  if (description.length > DESCRIPTION_MAX) {
    return fail(`description must be at most ${DESCRIPTION_MAX} characters`);
  }

  let costVsBenefits: string | null = null;
  if (input.costVsBenefits !== undefined && input.costVsBenefits !== null && input.costVsBenefits !== "") {
    if (typeof input.costVsBenefits !== "string") return fail("costVsBenefits must be a string");
    const trimmed = input.costVsBenefits.trim();
    if (trimmed.length > COST_VS_BENEFITS_MAX) {
      return fail(`costVsBenefits must be at most ${COST_VS_BENEFITS_MAX} characters`);
    }
    costVsBenefits = trimmed || null;
  }

  if (typeof input.isAnonymous !== "boolean") return fail("isAnonymous must be a boolean");

  return { ok: true, value: { description, costVsBenefits, isAnonymous: input.isAnonymous } };
}

// ── §10.3 Admin delete (platform admin) ───────────────────────────────────────────────────

/** Max length of the mandatory reason an admin gives when permanently deleting an item. */
export const DELETE_REASON_MAX = 500;

/** The reason is REQUIRED on every §10.3 delete: the audit row deliberately carries no
 *  content (no title/description/filenames), so the admin's own words are the only
 *  explanation of why an item vanished. Blank or over-long is refused (the route maps this
 *  to a 422). */
export function validateDeleteReason(reason: unknown): Result<string> {
  if (typeof reason !== "string" || reason.trim() === "") return fail("a reason is required to delete this item");
  const trimmed = reason.trim();
  if (trimmed.length > DELETE_REASON_MAX) return fail(`the reason must be at most ${DELETE_REASON_MAX} characters`);
  return { ok: true, value: trimmed };
}

/**
 * §10.3: the parent challenge's status after one of its solutions is permanently deleted.
 *
 * Deleting the `implemented` solution of a `solved` challenge un-solves the challenge —
 * back to `valid`, `resolved_at` cleared — because the thing that solved it no longer
 * exists. Everything else is left exactly as it is:
 *   - siblings closed as `not_selected` by the §8.3 auto-close STAY closed;
 *   - a challenge an admin has since moved elsewhere (e.g. `rejected`) is not force-set;
 *   - a solution deleted at a pre-`implemented` advanced status
 *     (`accepted_internally` … `external_acceptance`) never solved anything, so the
 *     challenge — still `valid` — is untouched and simply regains a free single-winner
 *     slot (invariant 7).
 *
 * Returns the status to set, or null for "change nothing".
 */
export function parentStatusAfterSolutionDelete(input: {
  solutionStatus: SolutionStatus;
  challengeStatus: ChallengeStatus;
}): ChallengeStatus | null {
  if (input.solutionStatus !== "implemented") return null;
  if (input.challengeStatus !== "solved") return null;
  return "valid";
}

/** Notification/outbox links belonging to a deleted subtree (§10.3 cascade). Every §12.1
 *  link is `/challenges/<n>` for a challenge and `/challenges/<n>#SOL-<m>` for a solution,
 *  so a challenge delete matches its own link plus every `#`-suffixed solution link, and a
 *  solution delete matches exactly one link. The `#` in the prefix is what keeps CH-4 from
 *  swallowing CH-42. */
export function notificationLinkScope(input: { challengeNumber: string | number; solutionNumber?: string | number | null }): {
  exact: string;
  prefix: string | null;
} {
  const ch = String(input.challengeNumber).replace(/\D/g, "");
  const sol = input.solutionNumber === undefined || input.solutionNumber === null ? null : String(input.solutionNumber).replace(/\D/g, "");
  if (sol === null) return { exact: `/challenges/${ch}`, prefix: `/challenges/${ch}#` };
  return { exact: `/challenges/${ch}#SOL-${sol}`, prefix: null };
}

// §40 Invite a solver — a nudge from one person to another to propose a solution to a challenge
// that accepts solutions (INNOBOX_SPEC.md §40). Pure rules only: the caps, the request parser, the
// "answered" rule behind the invitee's banner, and the user-facing copy of the dialog, the banner
// and events 22 and 23. DB access (eligibility, the caps' counts, the payoff) stays in the caller.
// Client-safe subpath export (`@innobox/shared/invitations`): no node deps.
import { formatChallengeNumber, formatSolutionNumber } from "./challenges.js";

/** §40.2 decision 3 — fixed in code, like the §23 weights. */
export const INVITES_PER_CHALLENGE = 5;
export const INVITES_PER_DAY = 20;
/** §40.2: the note's length after trimming. */
export const INVITE_NOTE_MAX = 500;
/** §40.6: the bell quotes the note on a second line, cut at this many characters. */
export const INVITE_NOTE_INBOX_MAX = 200;
/** §40.3: the banner shows this many notes before "Show N more". */
export const BANNER_NOTES_SHOWN = 3;

/** The user-facing refusals (§40.11), in the order the API checks them after the 404. */
export const INVITATION_MESSAGES = {
  notOpen: "This challenge isn't open for solutions, so nobody can be invited to it.",
  ineligible: "This person can't be invited to this challenge.",
  noteTooLong: `A note can be at most ${INVITE_NOTE_MAX} characters.`,
  challengeCap: `You can invite at most ${INVITES_PER_CHALLENGE} people to one challenge.`,
  dailyCap: `You've sent ${INVITES_PER_DAY} invitations today. You can send more tomorrow.`,
  noInvitation: "You have no invitation to this challenge.",
} as const;

/** §40.2: the Invite button's hints once the inviter has used their room. */
export const INVITE_CHALLENGE_CAP_HINT = `You've invited ${INVITES_PER_CHALLENGE} people to this challenge.`;
export const INVITE_DAILY_CAP_HINT = INVITATION_MESSAGES.dailyCap;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InvitationRequest {
  /** 1–5 distinct user ids, lower-cased. Eligibility (a 422) is the caller's. */
  userIds: string[];
  /** Trimmed; null when absent or empty after trimming. */
  note: string | null;
}

export type InvitationParse = { ok: true; value: InvitationRequest } | { ok: false; status: 400 | 422; error: string };

/** §40.2: an empty or whitespace-only note is no note; otherwise the trimmed text. */
export function normalizeInviteNote(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * §40.11: `POST /api/challenges/:number/invitations { userIds, note? }`. A malformed list is a 400 —
 * not 1–5 distinct ids; a note over 500 characters after trimming is a 422. The caller's own id is
 * left to the eligibility check, which refuses it with the one §40.2 message.
 */
export function parseInvitationRequest(body: Record<string, unknown>): InvitationParse {
  const raw = body.userIds;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > INVITES_PER_CHALLENGE || !raw.every((id) => typeof id === "string" && UUID_RE.test(id))) {
    return { ok: false, status: 400, error: `userIds must list 1–${INVITES_PER_CHALLENGE} people` };
  }
  const userIds = raw.map((id: string) => id.toLowerCase());
  if (new Set(userIds).size !== userIds.length) return { ok: false, status: 400, error: "userIds must not repeat a person" };
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== "string") return { ok: false, status: 400, error: "note must be text" };
    note = normalizeInviteNote(body.note);
    if (note !== null && note.length > INVITE_NOTE_MAX) return { ok: false, status: 422, error: INVITATION_MESSAGES.noteTooLong };
  }
  return { ok: true, value: { userIds, note } };
}

/** §40.2: why a send over the caps is refused — the per-challenge cap first. Null when it fits. */
export function invitationCapRefusal(request: number, sentOnChallenge: number, sentToday: number): "challenge_cap" | "daily_cap" | null {
  if (sentOnChallenge + request > INVITES_PER_CHALLENGE) return "challenge_cap";
  if (sentToday + request > INVITES_PER_DAY) return "daily_cap";
  return null;
}

/** §40.2: the inviter's room — on this challenge, and today across every challenge. */
export function invitationRoom(sentOnChallenge: number, sentToday: number): { left: number; leftToday: number } {
  return {
    left: Math.max(0, INVITES_PER_CHALLENGE - sentOnChallenge),
    leftToday: Math.max(0, INVITES_PER_DAY - sentToday),
  };
}

/** UTC midnight of `now`'s day — where the daily cap's count starts. Local time plays no part. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * §40.3: an invitation is ANSWERED by a solution the invitee was on the team of from the create and
 * that was created after it. `answeredAt` are the creation times of the invitee's solutions on the
 * challenge; the open invitations are the rest. A later invitation stays open until a later solution
 * answers it.
 */
export function isAnswered(invitedAt: Date, answeredAt: readonly Date[]): boolean {
  return answeredAt.some((a) => a.getTime() > invitedAt.getTime());
}

// ── Copy (§40.2, §40.3, §40.6) ───────────────────────────────────────────────────────────

/** The bell's line for event 22. The challenge's author is never named (§9). */
export function invitationMessage(inviterName: string, challengeNumber: string | number, challengeTitle: string): string {
  return `${inviterName} invited you to propose a solution to ${formatChallengeNumber(challengeNumber)} "${challengeTitle}".`;
}

/** Event 22's e-mail subject. */
export function invitationSubject(inviterName: string, challengeNumber: string | number): string {
  return `${inviterName} invited you to propose a solution to ${formatChallengeNumber(challengeNumber)}`;
}

/** The note as the bell quotes it: cut at 200 characters with an ellipsis (the banner shows it all). */
export function inboxNote(note: string): string {
  const flat = note.replace(/\s+/g, " ").trim();
  return flat.length <= INVITE_NOTE_INBOX_MAX ? flat : `${flat.slice(0, INVITE_NOTE_INBOX_MAX - 1).trimEnd()}…`;
}

/** Event 23's line: the invitee answered with a named solution, visible by then (§40.5). */
export function invitationPaidOffMessage(inviteeName: string, solutionNumber: string | number, challengeNumber: string | number): string {
  return `${inviteeName} answered your invitation with ${formatSolutionNumber(solutionNumber)} on ${formatChallengeNumber(challengeNumber)}.`;
}

/** §40.3: the banner's headline — the newest inviter named, the rest counted. */
export function invitationBannerHeadline(inviterNames: readonly string[]): string {
  const [newest, ...rest] = inviterNames;
  if (!newest) return "";
  if (rest.length === 0) return `${newest} invited you to propose a solution.`;
  return `${newest} and ${rest.length} ${rest.length === 1 ? "other" : "others"} invited you to propose a solution.`;
}

/** §40.2: the dialog's send button. */
export function sendInvitationsLabel(count: number): string {
  return count <= 1 ? "Send invitation" : `Send ${count} invitations`;
}

/** §40.2: the toast after a send. */
export function invitationsSentToast(count: number): string {
  return count === 1 ? "Invitation sent" : `${count} invitations sent`;
}

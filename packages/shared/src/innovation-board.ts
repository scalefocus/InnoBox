// The innovation board (INNOBOX_SPEC.md §45) — pure and CLIENT-SAFE (also exposed at
// `@innobox/shared/innovation-board` for the Administration card, the profile and the submit forms).
// One platform-wide list of people a platform admin keeps in the app. A member reads new challenges
// and solutions before review (the exemption itself lives in challenges.ts, §45.3) and is told of
// each one (§12.1 events 1 and 2, §45.5). This module owns the limits, the add request's validation
// and every line of copy; the rows and the dispatch live in the web tier.

/** §45.2: the board holds at most this many people — deactivated members count. Fixed in code. */
export const INNOVATION_BOARD_MAX = 100;
/** §45.2: at most this many people are added in one call. */
export const INNOVATION_BOARD_ADD_MAX = 20;

/** §45.10: the one refusal for an unknown, inactive or erased person. */
export const BOARD_INELIGIBLE = "This person can't be added to the innovation board.";
/** §45.10: the refusal over the cap. */
export const BOARD_FULL = `The innovation board can have at most ${INNOVATION_BOARD_MAX} members.`;
/** §45.2: the card's line at the cap, in place of the picker. */
export const BOARD_FULL_HINT = "The innovation board is full. Remove someone to add another person.";

export type BoardResult<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** §45.10: `userIds` of an add — 1 to 20 distinct user ids. Anything else is a malformed body. */
export function validateBoardUserIds(raw: unknown): BoardResult<string[]> {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "userIds must list at least one person" };
  if (raw.length > INNOVATION_BOARD_ADD_MAX) return { ok: false, error: `userIds must list at most ${INNOVATION_BOARD_ADD_MAX} people` };
  const ids: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !UUID.test(v)) return { ok: false, error: "userIds must be user ids" };
    const id = v.toLowerCase();
    if (ids.includes(id)) return { ok: false, error: "userIds must be distinct" };
    ids.push(id);
  }
  return { ok: true, value: ids };
}

// ── Copy ─────────────────────────────────────────────────────────────────────────────────

const digitsOf = (n: string | number): string => String(n).replace(/\D/g, "");

/** §45.5: event 1 as the board reads it — the admins' line says "needs triage", which is not a
 *  member's to do. Like every event-1 line it names no author (invariant 3). */
export function boardChallengeSubmittedMessage(number: string | number, title: string): string {
  return `New challenge CH-${digitsOf(number)} "${title}" was submitted.`;
}

/** §45.6 event 28: the inbox line. `adminName` is the platform admin who added the person. */
export function boardAddedMessage(adminName: string): string {
  return `${adminName} added you to the innovation board. You'll hear about every new challenge and solution.`;
}

/** §45.6 event 28: the e-mail's subject. */
export const BOARD_ADDED_SUBJECT = "You've been added to the innovation board";

/** §45.6 event 28: the e-mail's body — the worker appends the link to the profile. */
export function boardAddedEmailText(adminName: string): string {
  return [
    `${adminName} added you to the innovation board.`,
    "You can now read new challenges and solutions before they are reviewed, and you'll be told about each one.",
    "Your e-mail delivery choice applies to these notices: you can set it on your profile.",
  ].join("\n\n");
}

/** §45.7: the muted line at the top of a member's own notification preferences. */
export const BOARD_PROFILE_LINE =
  "You're on the innovation board: you can read new challenges and solutions before review, and you're told about each one. To stop, ask a platform admin to remove you.";

/** §45.7: the muted line above a submit button while the board has a member. `restricted` is the
 *  challenge's visibility being anything but organization-wide (§4.3) — the form's own choice on the
 *  challenge form, the parent challenge's on the solution form. */
export function boardFormNote(form: "challenge" | "solution", restricted: boolean): string {
  if (!restricted) return "The innovation board can read this before it's reviewed.";
  return form === "challenge"
    ? "Innovation board members in this namespace can read this before it's reviewed."
    : "Innovation board members who can see this challenge can read this before it's reviewed.";
}

/** §45.2: the Administration card. */
export const BOARD_CARD_SUBTITLE = "People on the board can read new challenges and solutions before review, and are told about each one.";
export const BOARD_EMPTY = "Nobody is on the innovation board yet.";

/** §45.2: the question the remove dialog asks. */
export function boardRemoveConfirm(name: string): string {
  return `Remove ${name} from the innovation board? They will no longer be able to read challenges and solutions before review, and the notices will stop.`;
}

// Challenges shared with specific people (INNOBOX_SPEC.md §4.3 `people`, §24.3): the access-list
// limits, the tag-field rules the /submit form and the admin list editor share, the outside
// submitter's visibility request, and the admin's list input. Pure and dependency-free, so it is
// client-safe (also exposed at `@innobox/shared/challenge-access`). The database half — writing
// the list, binding pending e-mails, event 15 — lives in ./challenge-access-db.ts.
import { PUBLIC_EMAIL_MAX, isEmailSyntax } from "./public-intake.js";

// ── Limits ───────────────────────────────────────────────────────────────────────────────────

/** A challenge's access list holds at most 100 entries (§4.3). */
export const ACCESS_LIST_MAX = 100;
/** The /submit form's *Specific people* field: 1–20 addresses (§24.3). */
export const REQUESTED_EMAILS_MAX = 20;
/** The /submit form's *Specific teams* field: 1–10 names (§24.3). */
export const REQUESTED_TEAMS_MAX = 10;
/** A team name has at least 3 characters after trimming — any characters count — and at most 100. */
export const TEAM_NAME_MIN = 3;
export const TEAM_NAME_MAX = 100;

/** The submitter's *Who should see this?* choice (§24.3). A request only: the admin settles the
 *  challenge's real visibility on accept (§24.5). */
export type RequestedVisibility = "org" | "people" | "teams";
export const REQUESTED_VISIBILITIES: readonly RequestedVisibility[] = ["org", "people", "teams"];

export const REQUESTED_VISIBILITY_LABELS: Record<RequestedVisibility, string> = {
  org: "Everyone in the organization",
  people: "Specific people",
  teams: "Specific teams",
};

// ── User-facing messages (shared by the browser and the API, so they always agree) ──────────

export const EMAIL_TAG_INVALID = "Enter a valid e-mail address.";
export const TEAM_TAG_INVALID = `Team names need at least ${TEAM_NAME_MIN} characters.`;
export const TAG_DUPLICATE = "Already added.";
export const EMAILS_REQUIRED = "Add at least one e-mail address.";
export const TEAMS_REQUIRED = "Add at least one team.";
export const ACCESS_LIST_REQUIRED = "Add at least one person, or choose a different visibility.";

// ── Tag-field rules (§24.3, §4.3) ────────────────────────────────────────────────────────────

export type TagCheck = { ok: true; value: string } | { ok: false; error: string };

/** Addresses are stored and compared lower-cased. */
export function normalizeAccessEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Can this text be locked in as an e-mail tag, given the tags already there? */
export function checkEmailTag(raw: string, existing: readonly string[]): TagCheck {
  const value = normalizeAccessEmail(raw);
  if (!isEmailSyntax(value)) return { ok: false, error: EMAIL_TAG_INVALID };
  if (existing.some((e) => normalizeAccessEmail(e) === value)) return { ok: false, error: TAG_DUPLICATE };
  return { ok: true, value };
}

/** Can this text be locked in as a team tag? Any characters count; the comparison for duplicates
 *  ignores case. The name keeps the case the submitter typed. */
export function checkTeamTag(raw: string, existing: readonly string[]): TagCheck {
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.length < TEAM_NAME_MIN || value.length > TEAM_NAME_MAX) return { ok: false, error: TEAM_TAG_INVALID };
  const folded = value.toLowerCase();
  if (existing.some((t) => t.trim().toLowerCase() === folded)) return { ok: false, error: TAG_DUPLICATE };
  return { ok: true, value };
}

/** A pasted list of addresses splits on commas, semicolons, spaces and line breaks. */
export function splitPastedEmails(text: string): string[] {
  return text.split(/[,;\s]+/).map((p) => p.trim()).filter((p) => p !== "");
}

/** A pasted list of team names splits on commas, semicolons and line breaks — not on spaces,
 *  which team names may contain. */
export function splitPastedTeams(text: string): string[] {
  return text.split(/[,;\r\n]+/).map((p) => p.trim()).filter((p) => p !== "");
}

/** The outcome of pasting into a tag field: the parts that became tags, and the rest, which stay
 *  in the field (joined back with the separator the field splits on) with the first error. */
export interface PasteOutcome {
  added: string[];
  rest: string;
  error: string | null;
}

export function applyPaste(kind: "email" | "team", text: string, existing: readonly string[], max: number): PasteOutcome {
  const parts = kind === "email" ? splitPastedEmails(text) : splitPastedTeams(text);
  const added: string[] = [];
  const rejected: string[] = [];
  let error: string | null = null;
  for (const part of parts) {
    if (existing.length + added.length >= max) {
      rejected.push(part);
      error ??= `At most ${max} can be added.`;
      continue;
    }
    const check = kind === "email" ? checkEmailTag(part, [...existing, ...added]) : checkTeamTag(part, [...existing, ...added]);
    if (check.ok) added.push(check.value);
    else {
      rejected.push(part);
      error ??= check.error;
    }
  }
  return { added, rest: rejected.join(kind === "email" ? " " : ", "), error };
}

// ── The outside submitter's request (§24.3, §24.9) ───────────────────────────────────────────

export interface VisibilityRequest {
  visibility: RequestedVisibility;
  /** Lower-cased, deduplicated; non-empty iff `people`. */
  emails: string[];
  /** Trimmed, deduplicated ignoring case; non-empty iff `teams`. */
  teams: string[];
}

export type RequestResult<T> = { ok: true; value: T } | { ok: false; error: string };

function stringArray(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) return null;
  return raw as string[];
}

/** `visibility` (default `org` when absent), and the array that goes with it. The other array must
 *  be absent or empty. Every tag passes the same rule the form applies on Enter. */
export function validateVisibilityRequest(body: Record<string, unknown>): RequestResult<VisibilityRequest> {
  const visibility = body.visibility === undefined ? "org" : body.visibility;
  if (visibility !== "org" && visibility !== "people" && visibility !== "teams") {
    return { ok: false, error: "Choose who should see this." };
  }
  const emailsRaw = stringArray(body.emails);
  const teamsRaw = stringArray(body.teams);
  if (emailsRaw === null || teamsRaw === null) return { ok: false, error: "The visibility lists must be lists of text." };
  if (visibility !== "people" && emailsRaw.length > 0) return { ok: false, error: "E-mail addresses apply only to Specific people." };
  if (visibility !== "teams" && teamsRaw.length > 0) return { ok: false, error: "Team names apply only to Specific teams." };

  const emails: string[] = [];
  for (const raw of emailsRaw) {
    const check = checkEmailTag(raw, emails);
    if (!check.ok) return { ok: false, error: check.error === TAG_DUPLICATE ? `${raw.trim()} is listed twice.` : check.error };
    emails.push(check.value);
  }
  const teams: string[] = [];
  for (const raw of teamsRaw) {
    const check = checkTeamTag(raw, teams);
    if (!check.ok) return { ok: false, error: check.error === TAG_DUPLICATE ? `${raw.trim()} is listed twice.` : check.error };
    teams.push(check.value);
  }
  if (visibility === "people" && emails.length === 0) return { ok: false, error: EMAILS_REQUIRED };
  if (visibility === "teams" && teams.length === 0) return { ok: false, error: TEAMS_REQUIRED };
  if (emails.length > REQUESTED_EMAILS_MAX) return { ok: false, error: `At most ${REQUESTED_EMAILS_MAX} e-mail addresses.` };
  if (teams.length > REQUESTED_TEAMS_MAX) return { ok: false, error: `At most ${REQUESTED_TEAMS_MAX} teams.` };
  return { ok: true, value: { visibility, emails, teams } };
}

// ── The admin's list (§4.3, §16) ─────────────────────────────────────────────────────────────

/** The access list an admin saves: users by id, and pending e-mails. */
export interface AccessListInput {
  userIds: string[];
  emails: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `{ userIds, emails }`, deduplicated, with 1–100 entries in all. Whether an id names an active
 *  user, and whether an address matches one, is the database's half. */
export function parseAccessListInput(raw: unknown): RequestResult<AccessListInput> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: ACCESS_LIST_REQUIRED };
  const o = raw as Record<string, unknown>;
  const ids = stringArray(o.userIds);
  const mails = stringArray(o.emails);
  if (ids === null || mails === null) return { ok: false, error: "access must hold lists of user ids and e-mails" };
  const userIds: string[] = [];
  for (const id of ids) {
    if (!UUID_RE.test(id)) return { ok: false, error: "access.userIds must be user ids" };
    const lower = id.toLowerCase();
    if (!userIds.includes(lower)) userIds.push(lower);
  }
  const emails: string[] = [];
  for (const mail of mails) {
    const value = normalizeAccessEmail(mail);
    if (value.length > PUBLIC_EMAIL_MAX || !isEmailSyntax(value)) return { ok: false, error: `${mail.trim()}: ${EMAIL_TAG_INVALID}` };
    if (!emails.includes(value)) emails.push(value);
  }
  const total = userIds.length + emails.length;
  if (total === 0) return { ok: false, error: ACCESS_LIST_REQUIRED };
  if (total > ACCESS_LIST_MAX) return { ok: false, error: `An access list holds at most ${ACCESS_LIST_MAX} people.` };
  return { ok: true, value: { userIds, emails } };
}

// ── What an admin sees (§4.3, §16) ───────────────────────────────────────────────────────────

/** One access-list entry as the item's admins see it: a user, or a pending address. */
export interface AccessEntryView {
  user: { id: string; displayName: string; email: string | null; active: boolean } | null;
  /** Set only on a pending entry. */
  email: string | null;
}

/** The chip a `people` challenge shows in place of *Organization-wide* / *Namespace-only*. */
export const PEOPLE_VISIBILITY_LABEL = "Shared with specific people";
export const PENDING_ACCESS_LABEL = "No InnoBox user yet";

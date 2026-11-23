// §43 Mentions — naming a colleague in a solution's text (INNOBOX_SPEC.md §43). Pure rules only:
// the mention token, binding (display text → stored text), the serializer (stored text → display
// text with ranges), the forms an AI prompt and an audit payload take, the caps, the status table
// of the settling check, the composer's query rule, and every user-facing string. DB access —
// eligibility, the caps' counts, the rows and the settling — stays in the caller.
// Client-safe subpath export (`@innobox/shared/mentions`): no node deps.
import { formatChallengeNumber, formatSolutionNumber, type SolutionStatus } from "./challenges.js";

// ── The token (§43.2) ────────────────────────────────────────────────────────────────────

/** A stored mention is U+E000, the person's user id, U+E001. Both are private-use characters the API
 *  removes from every submitted text, so nothing a person types can be read back as a mention. */
export const MENTION_OPEN = "";
export const MENTION_CLOSE = "";

const TOKEN_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
const MARKS_RE = /[]/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** §43.5 decision 9 — fixed in code, like the §40 caps. */
export const MENTIONS_PER_SOLUTION = 10;
export const MENTIONS_PER_DAY = 30;
/** §43.11: the name a form sends with a mention only finds the text; this bounds it. */
export const MENTION_NAME_MAX = 200;
/** §43.3: the list opens after this many characters and looks at no more than this many. */
export const MENTION_QUERY_MIN = 2;
export const MENTION_QUERY_MAX = 40;
/** §43.3: how many people the list shows, and the pause in typing before it searches. */
export const MENTION_LIST_SIZE = 8;
export const MENTION_SEARCH_DELAY_MS = 200;

/** What an erased person's mention reads as (§43.2) — the name the rest of the app gives them. */
export const MENTION_DELETED_NAME = "Deleted User";
/** §43.9: what an AI task that reads stored solution text receives in place of each mention. */
export const AI_STORED_MENTION = "@colleague";

/** The user-facing refusals (§43.5, §43.11), in the order the API checks them. */
export const MENTION_MESSAGES = {
  malformed: `mentions must list at most ${MENTIONS_PER_SOLUTION} people`,
  ineligible: "This person can't be mentioned in this solution.",
  solutionCap: `A solution can mention at most ${MENTIONS_PER_SOLUTION} people.`,
  dailyCap: `You've mentioned ${MENTIONS_PER_DAY} people today. You can mention more tomorrow.`,
} as const;

/** §43.3: the composer's copy. */
export const MENTIONED_ROW_LABEL = "Mentioned";
export const MENTION_HINT_LATER = "They'll be told once they can see this solution — for most, after a reviewer picks it up.";
export const MENTION_HINT_ON_SAVE = "They'll be told when you save.";
export const MENTION_ANONYMOUS_WARNING =
  "Mentions are part of the text everyone can read, and may hint at who wrote this. The people you mention aren't told who mentioned them.";

// ── Mentions in a comment (§44) ──────────────────────────────────────────────────────────
// The token, binding and the serializer above serve comments unchanged. What differs is who can be
// mentioned (only people who can read the thread right now), when they are told (at the save, by
// event 27) and the per-item cap; the daily cap is ONE budget across solution text and comments.

/** §44.5 decision 11 — fixed in code. */
export const MENTIONS_PER_COMMENT = 10;

/** The user-facing refusals of a comment's mentions (§44.5, §44.10), in the order the API checks. */
export const COMMENT_MENTION_MESSAGES = {
  malformed: `mentions must list at most ${MENTIONS_PER_COMMENT} people`,
  ineligible: "This person can't be mentioned in this comment.",
  commentCap: `A comment can mention at most ${MENTIONS_PER_COMMENT} people.`,
  dailyCap: MENTION_MESSAGES.dailyCap,
} as const;

/** §44.2: the comment box's copy. */
export const COMMENT_MENTION_HINT_POST = "They'll be told when you post.";
export const COMMENT_MENTION_HINT_SAVE = "They'll be told when you save.";
export const COMMENT_MARKDOWN_HINT = "Markdown: **bold**, *italic*, lists, > quote, links · @ to mention a colleague";
export const COMMENT_PREVIEW_EMPTY = "Nothing to preview.";

/** §44.5: why a comment save over the caps is refused — the per-comment cap first.
 *  `rowsOnComment` is the comment's rows after the save (the people its text mentions plus anyone
 *  told and since taken out); `createdToday` the rows the commenter created since UTC midnight in
 *  solution text AND comments together, this save's included. */
export function commentMentionCapRefusal(rowsOnComment: number, createdToday: number): "comment_cap" | "daily_cap" | null {
  if (rowsOnComment > MENTIONS_PER_COMMENT) return "comment_cap";
  if (createdToday > MENTIONS_PER_DAY) return "daily_cap";
  return null;
}

/** §44.10: the room the comment box shows — on this comment, and today across everything. */
export function commentMentionRoom(rowsOnComment: number, createdToday: number): { left: number; leftToday: number } {
  return {
    left: Math.max(0, MENTIONS_PER_COMMENT - rowsOnComment),
    leftToday: Math.max(0, MENTIONS_PER_DAY - createdToday),
  };
}

/** Where a comment sits — its challenge, and its solution on a solution's thread. */
export interface CommentMentionPlace {
  challengeNumber: string | number;
  /** Null on a challenge's own thread. */
  solutionNumber: string | number | null;
  challengeTitle: string;
}

/** The item a comment hangs under, as the notice names it: "CH-412" or "SOL-34". */
function commentItemLabel(place: Pick<CommentMentionPlace, "challengeNumber" | "solutionNumber">): string {
  return place.solutionNumber === null ? formatChallengeNumber(place.challengeNumber) : formatSolutionNumber(place.solutionNumber);
}

/** The bell's line for event 27 (§44.6). Comments are never anonymous (§9), so the commenter is
 *  always named; the item's own author never is. */
export function commentMentionedMessage(senderName: string, place: CommentMentionPlace): string {
  const challenge = `${formatChallengeNumber(place.challengeNumber)} "${place.challengeTitle}"`;
  const where = place.solutionNumber === null ? challenge : `${formatSolutionNumber(place.solutionNumber)} on ${challenge}`;
  return `${senderName} mentioned you in a comment on ${where}.`;
}

/** Event 27's e-mail subject. */
export function commentMentionedSubject(senderName: string, place: Pick<CommentMentionPlace, "challengeNumber" | "solutionNumber">): string {
  return `${senderName} mentioned you in a comment on ${commentItemLabel(place)}`;
}

/** The text with every U+E000 and U+E001 removed — the first thing done to any submitted text. */
export function stripMentionMarks(text: string): string {
  return text.replace(MARKS_RE, "");
}

export function mentionToken(userId: string): string {
  return `${MENTION_OPEN}${userId.toLowerCase()}${MENTION_CLOSE}`;
}

/** True when a stored text holds at least one token — the cheap test before any lookup. */
export function hasMentions(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.includes(MENTION_OPEN);
}

/** The distinct people the stored texts mention, in order of first appearance. */
export function mentionedUserIds(...stored: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const text of stored) {
    if (!hasMentions(text)) continue;
    for (const m of text!.matchAll(TOKEN_RE)) seen.add(m[1]!);
  }
  return [...seen];
}

// ── Binding: display text → stored text (§43.2) ──────────────────────────────────────────

/** A person to bind, with the name to look for in the text. */
export interface MentionCandidate {
  userId: string;
  name: string;
}

const WORD_RE = /[\p{L}\p{N}]/u;

/** The character (a whole code point) that ends right before `index`, or undefined at the start. */
function charBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(index - 2, index);
  }
  return text[index - 1];
}

/** The character (a whole code point) that starts at `index`, or undefined at the end. */
function charAt(text: string, index: number): string | undefined {
  if (index >= text.length) return undefined;
  const cp = text.codePointAt(index);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && WORD_RE.test(ch);

/** §43.2: an `@` may start a mention at the start of the text or after a character that is neither
 *  a letter nor a digit. */
function canStartMention(text: string, at: number): boolean {
  return !isWordChar(charBefore(text, at));
}

interface NameGroup {
  name: string;
  userIds: string[];
}

/** The candidates grouped by name, longest name first; people who share a name keep listed order. */
function nameGroups(candidates: readonly MentionCandidate[]): NameGroup[] {
  const groups = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const c of candidates) {
    const userId = c.userId.toLowerCase();
    if (c.name === "" || seen.has(userId)) continue;
    seen.add(userId);
    const ids = groups.get(c.name);
    if (ids) ids.push(userId);
    else groups.set(c.name, [userId]);
  }
  return [...groups].map(([name, userIds]) => ({ name, userIds })).sort((a, b) => b.name.length - a.name.length);
}

/** One pass over the text: every `@<name>` that binds is handed to `onMatch`, which returns what to
 *  write in its place; everything else is copied as it is. */
function replaceBound(text: string, candidates: readonly MentionCandidate[], onMatch: (userId: string, name: string) => string): string {
  const groups = nameGroups(candidates);
  if (groups.length === 0 || !text.includes("@")) return text;
  const used = new Map<string, number>();
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.charAt(i) !== "@" || !canStartMention(text, i)) {
      out += text.charAt(i);
      i += 1;
      continue;
    }
    const group = groups.find((g) => text.startsWith(g.name, i + 1) && !isWordChar(charAt(text, i + 1 + g.name.length)));
    if (!group) {
      out += "@";
      i += 1;
      continue;
    }
    // §43.2: people who share a name take its occurrences in turn; further ones go to the last.
    const nth = used.get(group.name) ?? 0;
    used.set(group.name, nth + 1);
    out += onMatch(group.userIds[Math.min(nth, group.userIds.length - 1)]!, group.name);
    i += 1 + group.name.length;
  }
  return out;
}

/**
 * §43.2: turns submitted display text into stored text. Every `@<name>` of a listed person that
 * starts at the start of the text or after a non-letter, non-digit, and ends at the end of the text
 * or before a non-letter, non-digit, becomes that person's token. Exact comparison, case included;
 * longer names first. Any U+E000 / U+E001 in the input is removed first.
 */
export function bindMentions(text: string, candidates: readonly MentionCandidate[]): { text: string; userIds: string[] } {
  const stored = replaceBound(stripMentionMarks(text), candidates, (userId) => mentionToken(userId));
  return { text: stored, userIds: mentionedUserIds(stored) };
}

/** The listed people binding would find in any of the texts — what the *Mentioned* row shows. */
export function boundUserIds(texts: readonly (string | null | undefined)[], candidates: readonly MentionCandidate[]): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const id of bindMentions(text, candidates).userIds) seen.add(id);
  }
  return [...seen];
}

// ── The serializer: stored text → display text (§43.2, §43.7) ────────────────────────────

/** Where a mention sits in the display text, in UTF-16 code units. */
export interface MentionRange {
  start: number;
  length: number;
  userId: string;
}

/** Stored text as display text — each token written as `@` and `nameOf(userId)` — with the range
 *  of every mention in that display text. */
export function renderMentions(stored: string, nameOf: (userId: string) => string): { text: string; ranges: MentionRange[] } {
  if (!hasMentions(stored)) return { text: stripMentionMarks(stored), ranges: [] };
  const ranges: MentionRange[] = [];
  let out = "";
  let last = 0;
  for (const m of stored.matchAll(TOKEN_RE)) {
    // A stray mark that is part of no well-formed token is never shown.
    out += stripMentionMarks(stored.slice(last, m.index));
    const shown = `@${nameOf(m[1]!)}`;
    ranges.push({ start: out.length, length: shown.length, userId: m[1]! });
    out += shown;
    last = m.index + m[0].length;
  }
  out += stripMentionMarks(stored.slice(last));
  return { text: out, ranges };
}

/** Stored text as display text, without the ranges. */
export function displayMentions(stored: string, nameOf: (userId: string) => string): string {
  return renderMentions(stored, nameOf).text;
}

/** §43.11: in an audit payload a token is written as `@[user:<id>]` — an id, never a name. */
export function auditMentions(stored: string | null): string | null {
  if (stored === null || !hasMentions(stored)) return stored;
  return stored.replace(TOKEN_RE, (_m, id: string) => `@[user:${id}]`);
}

/** §43.9: stored text for an AI task — each mention a neutral placeholder, never a name. */
export function aiSafeMentions(stored: string): string {
  return hasMentions(stored) ? stripMentionMarks(stored.replace(TOKEN_RE, AI_STORED_MENTION)) : stored;
}

// ── The drafting aid (§43.9) ─────────────────────────────────────────────────────────────

const PLACEHOLDER_RE = /@\[(\d{1,3})\]/g;

/**
 * §43.9: the texts of a draft with every mention replaced by a numbered placeholder — `@[1]`,
 * `@[2]`, … — so no person's name reaches the provider. `names[n - 1]` is what `@[n]` stood for.
 * A placeholder-shaped string the author typed themselves is defused first, so the model's output
 * can never turn it into a mention.
 */
export function maskMentionsForAi(texts: readonly string[], candidates: readonly MentionCandidate[]): { texts: string[]; names: string[] } {
  const numbers = new Map<string, number>();
  const names: string[] = [];
  const masked = texts.map((text) =>
    replaceBound(stripMentionMarks(text).replace(PLACEHOLDER_RE, "@ [$1]"), candidates, (userId, name) => {
      let n = numbers.get(userId);
      if (n === undefined) {
        names.push(name);
        n = names.length;
        numbers.set(userId, n);
      }
      return `@[${n}]`;
    }),
  );
  return { texts: masked, names };
}

/** §43.9: the model's text with each known placeholder turned back into `@` and the name, and any
 *  other placeholder removed. */
export function unmaskMentionsFromAi(text: string, names: readonly string[]): string {
  return text.replace(PLACEHOLDER_RE, (_m, digits: string) => {
    const name = names[Number(digits) - 1];
    return name === undefined ? "" : `@${name}`;
  });
}

// ── The request (§43.11) ─────────────────────────────────────────────────────────────────

export type MentionsParse = { ok: true; value: MentionCandidate[] | null } | { ok: false; error: string };

/**
 * §43.11: the optional `mentions: [{ userId, name }]` of a solution create, edit or draft. Absent
 * (or null) is `null` — "no list": a create then has no mentions, an edit binds the current ones.
 * Malformed — not an array of at most 10 entries with distinct ids and a name of 1–200 characters —
 * is a 400.
 */
export function parseMentionsInput(raw: unknown): MentionsParse {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!Array.isArray(raw) || raw.length > MENTIONS_PER_SOLUTION) return { ok: false, error: MENTION_MESSAGES.malformed };
  const value: MentionCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return { ok: false, error: MENTION_MESSAGES.malformed };
    const { userId, name } = entry as { userId?: unknown; name?: unknown };
    if (typeof userId !== "string" || !UUID_RE.test(userId)) return { ok: false, error: MENTION_MESSAGES.malformed };
    if (typeof name !== "string" || name.length === 0 || name.length > MENTION_NAME_MAX) return { ok: false, error: MENTION_MESSAGES.malformed };
    const id = userId.toLowerCase();
    if (seen.has(id)) return { ok: false, error: "mentions must not repeat a person" };
    seen.add(id);
    value.push({ userId: id, name: stripMentionMarks(name) });
  }
  return { ok: true, value };
}

// ── The caps (§43.5) ─────────────────────────────────────────────────────────────────────

/** §43.5: why a save over the caps is refused — the per-solution cap first. `rowsOnSolution` is the
 *  solution's rows after the save (its mentions plus anyone settled and since removed);
 *  `createdToday` the rows the saver created since UTC midnight, this save's included. */
export function mentionCapRefusal(rowsOnSolution: number, createdToday: number): "solution_cap" | "daily_cap" | null {
  if (rowsOnSolution > MENTIONS_PER_SOLUTION) return "solution_cap";
  if (createdToday > MENTIONS_PER_DAY) return "daily_cap";
  return null;
}

/** §43.11: the room a form shows — on this solution, and today across every solution. */
export function mentionRoom(rowsOnSolution: number, createdToday: number): { left: number; leftToday: number } {
  return {
    left: Math.max(0, MENTIONS_PER_SOLUTION - rowsOnSolution),
    leftToday: Math.max(0, MENTIONS_PER_DAY - createdToday),
  };
}

// ── The settling check (§43.4) ───────────────────────────────────────────────────────────

/** Whom the check settles for a solution in this status: everyone pending (`all`), only the pending
 *  people who can already see a `proposed` solution (`viewers`), or nobody (`none`). */
export type MentionSettleScope = "all" | "viewers" | "none";

/** §43.4: the status table. A closed solution tells nobody (decision 3). */
export function mentionSettleScope(status: SolutionStatus): MentionSettleScope {
  if (status === "proposed") return "viewers";
  if (status === "rejected" || status === "not_selected" || status === "withdrawn") return "none";
  return "all";
}

/** §43.3: which line sits under the *Mentioned* row — a mention on a solution open to everyone is
 *  told at the save; on the propose form, or while `proposed`, once the person can see it. */
export function mentionHint(status: SolutionStatus | null): string {
  return status !== null && mentionSettleScope(status) === "all" ? MENTION_HINT_ON_SAVE : MENTION_HINT_LATER;
}

// ── The composer (§43.3) ─────────────────────────────────────────────────────────────────

/**
 * §43.3: the mention query the caret is in, or null when the list should be closed. The nearest
 * `@` before the caret opens it when it may start a mention, at least 2 and at most 40 characters
 * follow it up to the caret, and none of them is a line break. An `@` that already begins a picked
 * person's name (`boundNames`) is a finished mention and opens nothing.
 */
export function activeMentionQuery(text: string, caret: number, boundNames: readonly string[] = []): { start: number; query: string } | null {
  if (caret <= 0) return null;
  const from = Math.max(0, caret - MENTION_QUERY_MAX - 1);
  const start = text.lastIndexOf("@", caret - 1);
  if (start < from || start < 0) return null;
  if (!canStartMention(text, start)) return null;
  const typed = text.slice(start + 1, caret);
  if (typed.length < MENTION_QUERY_MIN || typed.includes("\n") || typed.includes("\r")) return null;
  for (const name of boundNames) {
    if (name !== "" && text.startsWith(name, start + 1) && !isWordChar(charAt(text, start + 1 + name.length))) return null;
  }
  const query = typed.trim();
  return query.length < MENTION_QUERY_MIN ? null : { start, query };
}

/** §43.3: the text after a pick — the `@` and the query replaced by `@`, the name and a space — and
 *  where the caret goes: after that space. A space already there is used instead of a second one. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const rest = text.slice(caret);
  const inserted = `@${name}${rest.startsWith(" ") ? "" : " "}`;
  return { text: `${text.slice(0, start)}${inserted}${rest}`, caret: start + name.length + 2 };
}

// ── Copy (§43.6) ─────────────────────────────────────────────────────────────────────────

/** The bell's line for event 26. `senderName` is null for an anonymous solution and for a sender
 *  who has been erased: the notice then names nobody. The challenge's author is never named (§9). */
export function mentionedMessage(senderName: string | null, solutionNumber: string | number, challengeNumber: string | number, challengeTitle: string): string {
  const where = `${formatSolutionNumber(solutionNumber)} on ${formatChallengeNumber(challengeNumber)} "${challengeTitle}"`;
  return senderName ? `${senderName} mentioned you in ${where}.` : `You were mentioned in ${where}.`;
}

/** Event 26's e-mail subject. */
export function mentionedSubject(senderName: string | null, solutionNumber: string | number): string {
  return senderName ? `${senderName} mentioned you in ${formatSolutionNumber(solutionNumber)}` : `You were mentioned in ${formatSolutionNumber(solutionNumber)}`;
}

// Feature ideas (INNOBOX_SPEC.md §38) — pure and CLIENT-SAFE (also at `@innobox/shared/feature-ideas`):
// the limits, the Coming soon entry ids, proposal and published-copy validation, the Approve
// dialog's pre-fill, the §38.2 order, the §38.3 voter-list split, the §38.8 notification copy and
// the §38.9 sweep plan. Every DB read and write lives in the callers (web stores, the worker sweep,
// and the server-only ./feature-ideas-db.ts).
import { UPCOMING_KEY_PATTERN, isUpcomingAudience, type UpcomingAudience, type UpcomingEntry, type UpcomingViewer } from "./upcoming.js";

// ── Limits ───────────────────────────────────────────────────────────────────────────────

/** §38.4: the proposal text. */
export const FEATURE_IDEA_TEXT_MAX = 1000;
/** §38.5: the admin's published copy. */
export const FEATURE_IDEA_TITLE_MAX = 60;
export const FEATURE_IDEA_TEASER_MAX = 280;
/** §38.5: the optional note sent with a decline. */
export const FEATURE_IDEA_NOTE_MAX = 1000;
/** §38.4: proposals a person may have waiting for review at once. */
export const MAX_PENDING_IDEAS = 3;
/** §38.3: named voters shown before "+N". */
export const VOTERS_SHOWN = 12;
/** §38.8: how much of a declined proposal its e-mail quotes. */
export const DECLINED_EXCERPT_MAX = 200;
/** §38.5: how much of a pending proposal its row shows. */
export const PENDING_ROW_EXCERPT_MAX = 160;

export const FEATURE_IDEA_STATUSES = ["pending", "planned", "declined", "merged"] as const;
export type FeatureIdeaStatus = (typeof FEATURE_IDEA_STATUSES)[number];

export const FEATURE_IDEA_STATUS_LABEL: Record<FeatureIdeaStatus, string> = {
  pending: "Waiting for review",
  planned: "Planned",
  declined: "Declined",
  merged: "Merged",
};

export const AUDIENCE_LABEL: Record<UpcomingAudience, string> = {
  everyone: "Everyone",
  admins: "Admins",
  platform_admin: "Platform admins",
};

/** The plain messages the routes answer with (§21.9: no spec references). */
export const FEATURE_IDEA_MESSAGES = {
  tooManyPending: `You have ${MAX_PENDING_IDEAS} ideas waiting for review. You can propose another once one of them is decided.`,
  alreadyDecided: "Another admin has already reviewed this idea.",
  alreadyDecidedOwn: "This idea has already been reviewed.",
  off: "Feature ideas are off. Turn them on to review.",
  notVisibleToProposer: "Not visible to the person who proposed this",
  notFound: "idea not found",
} as const;

// ── Coming soon entry ids (§38.2) ────────────────────────────────────────────────────────

export type EntryRef = { kind: "spec"; key: string } | { kind: "idea"; id: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function specEntryId(key: string): string {
  return `spec:${key}`;
}

export function ideaEntryId(id: string): string {
  return `idea:${id}`;
}

/** `spec:<key>` or `idea:<uuid>` → the entry it names; anything else → null. */
export function parseEntryId(value: unknown): EntryRef | null {
  if (typeof value !== "string") return null;
  if (value.startsWith("spec:")) {
    const key = value.slice("spec:".length);
    return UPCOMING_KEY_PATTERN.test(key) ? { kind: "spec", key } : null;
  }
  if (value.startsWith("idea:")) {
    const id = value.slice("idea:".length);
    return UUID_RE.test(id) ? { kind: "idea", id: id.toLowerCase() } : null;
  }
  return null;
}

export function entryIdOf(ref: EntryRef): string {
  return ref.kind === "spec" ? specEntryId(ref.key) : ideaEntryId(ref.id);
}

// ── Viewers ──────────────────────────────────────────────────────────────────────────────

/** The §13.9 audience view of a resolved role set (invariant 1: SCIM groups + role mappings). */
export function upcomingViewerOf(roles: { isPlatformAdmin: boolean; grants: readonly { role: string; namespaceId: string | null }[] }): UpcomingViewer {
  return {
    platformAdmin: roles.isPlatformAdmin,
    namespaceAdmin: [...new Set(roles.grants.filter((g) => g.role === "namespace_admin" && g.namespaceId !== null).map((g) => g.namespaceId as string))],
  };
}

// ── Validation ───────────────────────────────────────────────────────────────────────────

export type IdeaResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** §38.4: required, trimmed, at most FEATURE_IDEA_TEXT_MAX characters. */
export function validateIdeaText(value: unknown): IdeaResult<string> {
  if (typeof value !== "string" || value.trim() === "") return { ok: false, error: "Describe your idea first." };
  const text = value.trim();
  if (text.length > FEATURE_IDEA_TEXT_MAX) return { ok: false, error: `Your idea can be at most ${FEATURE_IDEA_TEXT_MAX} characters.` };
  return { ok: true, value: text };
}

export interface PublishedCopy {
  title: string;
  teaser: string;
  audience: UpcomingAudience;
}

const GAP_MARKER_RE = /GAP-\d+/;
const SECTION_MARK = String.fromCharCode(0xa7);

/** True when copy carries an internal reference that must never reach a user (§21.9, §13.9). */
export function hasInternalReference(text: string): boolean {
  return text.includes(SECTION_MARK) || GAP_MARKER_RE.test(text);
}

/** §38.5: the admin's title, teaser and audience — required, capped, free of internal references. */
export function validatePublishedCopy(body: unknown): IdeaResult<PublishedCopy> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "request body must be a JSON object" };
  const rec = body as Record<string, unknown>;
  const title = typeof rec.title === "string" ? rec.title.trim() : "";
  const teaser = typeof rec.teaser === "string" ? rec.teaser.trim() : "";
  if (!title) return { ok: false, error: "A title is required." };
  if (!teaser) return { ok: false, error: "A teaser is required." };
  if (title.length > FEATURE_IDEA_TITLE_MAX) return { ok: false, error: `The title can be at most ${FEATURE_IDEA_TITLE_MAX} characters.` };
  if (teaser.length > FEATURE_IDEA_TEASER_MAX) return { ok: false, error: `The teaser can be at most ${FEATURE_IDEA_TEASER_MAX} characters.` };
  if (hasInternalReference(title) || hasInternalReference(teaser)) {
    return { ok: false, error: "The title and teaser can't contain internal references such as section marks or gap markers." };
  }
  if (!isUpcomingAudience(rec.audience)) return { ok: false, error: "audience must be one of: everyone, admins, platform_admin" };
  return { ok: true, value: { title, teaser, audience: rec.audience } };
}

/** §38.5: the optional decline note — trimmed, empty → null, at most FEATURE_IDEA_NOTE_MAX. */
export function validateDecisionNote(value: unknown): IdeaResult<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "note must be a string" };
  const note = value.trim();
  if (note.length > FEATURE_IDEA_NOTE_MAX) return { ok: false, error: `The note can be at most ${FEATURE_IDEA_NOTE_MAX} characters.` };
  return { ok: true, value: note === "" ? null : note };
}

// ── The Approve dialog's pre-fill (§38.5) ────────────────────────────────────────────────

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** `text` cut to at most `max` characters at a word boundary, with an ellipsis when it was cut. */
export function cutAtWord(text: string, max: number): string {
  const flat = oneLine(text);
  if (flat.length <= max) return flat;
  const room = flat.slice(0, max - 1);
  const space = room.lastIndexOf(" ");
  const cut = trimTrailing(space > max / 3 ? room.slice(0, space) : room, (ch) => /[\s,;:.!?-]/.test(ch));
  return `${cut}…`;
}

/** `text` without the trailing characters `drop` matches — a linear scan, never a backtracking
 *  regex, since the text is whatever a person typed. */
function trimTrailing(text: string, drop: (ch: string) => boolean): string {
  let end = text.length;
  while (end > 0 && drop(text[end - 1]!)) end -= 1;
  return text.slice(0, end);
}

const isSentenceEnd = (ch: string): boolean => ch === "." || ch === "!" || ch === "?";

/** The text's first sentence (up to the first `.`, `!` or `?` followed by a space, or the first
 *  line break), cut at a word boundary. */
export function titlePrefill(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0] ?? "";
  let sentence = firstLine;
  for (let i = 0; i < firstLine.length; i += 1) {
    if (isSentenceEnd(firstLine[i]!) && (i + 1 === firstLine.length || /\s/.test(firstLine[i + 1]!))) {
      sentence = firstLine.slice(0, i + 1);
      break;
    }
  }
  return cutAtWord(trimTrailing(sentence, isSentenceEnd), FEATURE_IDEA_TITLE_MAX);
}

export function teaserPrefill(text: string): string {
  return cutAtWord(text, FEATURE_IDEA_TEASER_MAX);
}

/** A quoted excerpt of a proposal, for the decline e-mail and the pending rows. */
export function ideaExcerpt(text: string, max: number): string {
  return cutAtWord(text, max);
}

// ── The order (§38.2) ────────────────────────────────────────────────────────────────────

export interface OrderableEntry {
  kind: "spec" | "idea";
  votes: number;
  /** A specified teaser's position in UPCOMING. */
  specIndex?: number;
  /** A planned idea's approval time (ISO). */
  approvedAt?: string;
}

/** Votes descending; among equals specified teasers first in hand order, then ideas oldest approval first. */
export function compareEntries(a: OrderableEntry, b: OrderableEntry): number {
  if (a.votes !== b.votes) return b.votes - a.votes;
  if (a.kind !== b.kind) return a.kind === "spec" ? -1 : 1;
  if (a.kind === "spec") return (a.specIndex ?? 0) - (b.specIndex ?? 0);
  return (a.approvedAt ?? "").localeCompare(b.approvedAt ?? "");
}

// ── The voter list (§38.3) ───────────────────────────────────────────────────────────────

export interface VoteRow {
  userId: string;
  displayName: string;
  deactivated: boolean;
  /** The voter's name switch is on and they are not erased (§38.6). */
  named: boolean;
}

export interface Voter {
  id: string;
  displayName: string;
  deactivated: boolean;
}

export interface VoterList {
  votes: number;
  voted: boolean;
  /** The named voters, newest first. */
  voters: Voter[];
  /** Voters counted but not named: opted out or erased. */
  othersCount: number;
  othersIncludesYou: boolean;
}

/** Splits an entry's votes (newest first) into the named list and the unnamed count. */
export function splitVoters(rows: readonly VoteRow[], viewerId: string): VoterList {
  const voters: Voter[] = [];
  let othersCount = 0;
  let othersIncludesYou = false;
  for (const row of rows) {
    if (row.named) voters.push({ id: row.userId, displayName: row.displayName, deactivated: row.deactivated });
    else {
      othersCount += 1;
      if (row.userId === viewerId) othersIncludesYou = true;
    }
  }
  return { votes: rows.length, voted: rows.some((r) => r.userId === viewerId), voters, othersCount, othersIncludesYou };
}

/** "and 3 others" / "and 3 others, including you" — empty when nobody is unnamed. */
export function othersLine(othersCount: number, includesYou: boolean, anyNamed: boolean): string {
  if (othersCount === 0) return "";
  const lead = anyNamed ? "and " : "";
  const noun = othersCount === 1 ? (anyNamed ? "1 other" : "1 person") : anyNamed ? `${othersCount} others` : `${othersCount} people`;
  return `${lead}${noun}${includesYou ? ", including you" : ""}`;
}

// ── Notifications (§38.8) ────────────────────────────────────────────────────────────────

export type ReviewOutcome = "approved" | "declined" | "merged";

export interface IdeaNotification {
  message: string;
  subject: string;
  /** The e-mail body when it says more than the inbox line. */
  emailText: string;
  link: string;
}

export const COMING_SOON_LINK = "/whats-new#coming-soon";

/** Event 19, for one of the proposer's own proposals. It names no admin. */
export function ideaReviewedNotification(
  outcome: ReviewOutcome,
  input: { title?: string | null; teaser?: string | null; text: string; note?: string | null },
): IdeaNotification {
  const title = oneLine(input.title ?? "");
  const teaser = oneLine(input.teaser ?? "");
  if (outcome === "approved") {
    return {
      message: `Your idea is planned: ${title}.`,
      subject: "Your feature idea is planned",
      emailText: `A platform admin approved your feature idea. It is now planned as "${title}": ${teaser}`,
      link: COMING_SOON_LINK,
    };
  }
  if (outcome === "merged") {
    return {
      message: `Your idea is already planned: ${title}.`,
      subject: "Your feature idea is already planned",
      emailText: `A platform admin found that your feature idea is already planned as "${title}": ${teaser}\n\nYour upvote was added to it.`,
      link: COMING_SOON_LINK,
    };
  }
  const note = input.note ? `\n\nNote from the reviewer: ${input.note}` : "";
  return {
    message: "Your feature idea wasn't taken forward.",
    subject: "Your feature idea was reviewed",
    emailText: `A platform admin reviewed your feature idea and isn't taking it forward.\n\nYour idea: "${ideaExcerpt(input.text, DECLINED_EXCERPT_MAX)}"${note}`,
    link: "/profile",
  };
}

/** Event 20, to the proposer ("you proposed it") or a voter ("you upvoted it"). */
export function featureAvailableNotification(title: string, relation: "proposed" | "upvoted"): IdeaNotification {
  const name = oneLine(title);
  const yours = relation === "proposed" ? "You proposed it." : "You upvoted it.";
  return {
    message: `${name} is now available. ${yours}`,
    subject: `Now available: ${name}`,
    emailText: `${name} is now available in InnoBox. ${yours} See What's new for the details.`,
    link: "/whats-new",
  };
}

// ── The shipped-teaser sweep (§38.9) ─────────────────────────────────────────────────────

export interface MirroredTeaser {
  key: string;
  title: string;
  audience: UpcomingAudience;
}

export interface TeaserSweepPlan {
  /** Every live teaser, to upsert into the mirror with its current title. */
  upserts: MirroredTeaser[];
  /** Mirrored keys no longer live and not dropped: announce to their voters, then clear. */
  shipped: MirroredTeaser[];
  /** Mirrored keys no longer live and on the dropped list: clear silently. */
  dropped: MirroredTeaser[];
}

export function planTeaserSweep(mirror: readonly MirroredTeaser[], live: readonly UpcomingEntry[], droppedKeys: readonly string[]): TeaserSweepPlan {
  const liveKeys = new Set(live.map((e) => e.key));
  const dropped = new Set(droppedKeys);
  const gone = mirror.filter((m) => !liveKeys.has(m.key));
  return {
    upserts: live.map((e) => ({ key: e.key, title: e.title, audience: e.audience })),
    shipped: gone.filter((m) => !dropped.has(m.key)),
    dropped: gone.filter((m) => dropped.has(m.key)),
  };
}

/** Event 20's recipients before the audience filter: the proposer first, then the voters —
 *  deduplicated, without the actor (§12.1: actors never notify themselves). */
export function featureAvailableCandidates(proposerId: string | null, voterIds: readonly string[], actorId: string | null): { userId: string; relation: "proposed" | "upvoted" }[] {
  const out: { userId: string; relation: "proposed" | "upvoted" }[] = [];
  const seen = new Set<string>();
  const add = (userId: string | null, relation: "proposed" | "upvoted") => {
    if (!userId || userId === actorId || seen.has(userId)) return;
    seen.add(userId);
    out.push({ userId, relation });
  };
  add(proposerId, "proposed");
  for (const id of voterIds) add(id, "upvoted");
  return out;
}

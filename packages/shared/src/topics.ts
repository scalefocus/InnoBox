// §34 Topics — curated tags a person can follow (INNOBOX_SPEC.md §34). Pure rules only: the
// field limits, the tagging rules (the cap, active-only adds, the bulk outcomes), the diff the
// audit records and the event-18 copy. DB access (the list, who follows what, visibility) stays
// in the caller. Client-safe subpath export (`@innobox/shared/topics`): no node deps.
import { formatChallengeNumber } from "./challenges.js";

/** §34.2 — a topic's name, after trimming. */
export const TOPIC_NAME_MAX = 40;
/** §34.2 — a topic's optional description. */
export const TOPIC_DESCRIPTION_MAX = 200;
/** §34.3 — topics on one challenge, a retired one still on it included. */
export const TOPICS_PER_CHALLENGE_MAX = 3;
/** §34.2 — active topics at once, so the pickers and `/topics` stay usable. Retired ones are free. */
export const ACTIVE_TOPICS_MAX = 100;
/** §34.5 — where every event-18 e-mail sends a person to manage their topics. */
export const TOPICS_PATH = "/topics";

/** §34.8 `topic_notices.via`: the trigger that told the person — or event 15 (`shared`). */
export const TOPIC_NOTICE_VIA = ["opening", "topic_added", "widened", "shared"] as const;
export type TopicNoticeVia = (typeof TOPIC_NOTICE_VIA)[number];

/** A topic as it rides on a challenge payload (§34.9). */
export interface TopicRef {
  id: string;
  name: string;
  active: boolean;
}

export type TopicResult<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** §34.2: 1–40 characters after trimming, plain text. Uniqueness is the database's. */
export function validateTopicName(raw: unknown): TopicResult<string> {
  if (typeof raw !== "string") return { ok: false, error: "Enter a name for the topic." };
  const name = raw.trim().replace(/\s+/g, " ");
  if (name === "") return { ok: false, error: "Enter a name for the topic." };
  if (name.length > TOPIC_NAME_MAX) return { ok: false, error: `A topic name can be at most ${TOPIC_NAME_MAX} characters.` };
  return { ok: true, value: name };
}

/** §34.2: optional, at most 200 characters; empty or absent is no description. */
export function validateTopicDescription(raw: unknown): TopicResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "The description must be text." };
  const description = raw.trim();
  if (description === "") return { ok: true, value: null };
  if (description.length > TOPIC_DESCRIPTION_MAX) {
    return { ok: false, error: `A topic description can be at most ${TOPIC_DESCRIPTION_MAX} characters.` };
  }
  return { ok: true, value: description };
}

/** §34.3: the `topicIds` a request carries — an array of distinct topic ids, at most three.
 *  Absent is "no change" for the caller to decide; this only checks the shape. */
export function parseTopicIds(raw: unknown): TopicResult<string[]> {
  if (!Array.isArray(raw)) return { ok: false, error: "topicIds must be an array of topic ids" };
  const ids: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !UUID_RE.test(v)) return { ok: false, error: "topicIds must be an array of topic ids" };
    const id = v.toLowerCase();
    if (ids.includes(id)) return { ok: false, error: "A topic can be added to a challenge only once." };
    ids.push(id);
  }
  if (ids.length > TOPICS_PER_CHALLENGE_MAX) return { ok: false, error: TOPIC_SET_ERROR.too_many };
  return { ok: true, value: ids };
}

/** Why a proposed set of topics is refused (§34.3, all 422). */
export type TopicSetProblem = "too_many" | "unknown" | "inactive";

export const TOPIC_SET_ERROR: Record<TopicSetProblem, string> = {
  too_many: `A challenge can have at most ${TOPICS_PER_CHALLENGE_MAX} topics.`,
  unknown: "That topic doesn't exist.",
  inactive: "That topic is no longer available.",
};

/**
 * §34.3: may a challenge whose topics are `current` carry `next` instead? At most three; every id
 * must be a known topic; a topic may be ADDED only while active, while a retired one already on
 * the challenge may stay (and counts toward the three). Removing is always allowed.
 */
export function checkTopicSet(
  next: readonly string[],
  current: readonly string[],
  known: ReadonlyMap<string, { active: boolean }>,
): TopicSetProblem | null {
  if (next.length > TOPICS_PER_CHALLENGE_MAX) return "too_many";
  for (const id of next) {
    const topic = known.get(id);
    if (!topic) return "unknown";
    if (!topic.active && !current.includes(id)) return "inactive";
  }
  return null;
}

/** The ids added and removed between two sets — the audit's `added` / `removed` (§34.3). */
export function topicDiff(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  return { added: after.filter((id) => !before.includes(id)), removed: before.filter((id) => !after.includes(id)) };
}

/** A §14.1 bulk *Add topic* / *Remove topic* outcome for one challenge (§34.6). */
export type BulkTopicOutcome = "ok" | "unchanged" | "topic_limit";

/** What one bulk action does to one challenge's topics: `unchanged` when it already had (or
 *  lacked) the topic, `topic_limit` when adding would make four. */
export function bulkTopicChange(current: readonly string[], action: "add" | "remove", topicId: string): { outcome: BulkTopicOutcome; next: string[] } {
  if (action === "remove") {
    if (!current.includes(topicId)) return { outcome: "unchanged", next: [...current] };
    return { outcome: "ok", next: current.filter((id) => id !== topicId) };
  }
  if (current.includes(topicId)) return { outcome: "unchanged", next: [...current] };
  if (current.length >= TOPICS_PER_CHALLENGE_MAX) return { outcome: "topic_limit", next: [...current] };
  return { outcome: "ok", next: [...current, topicId] };
}

// ── Copy (§34.5, event 18) ───────────────────────────────────────────────────────────────

/** Topic names in the one order every surface uses: alphabetical, case-insensitively. */
export function sortTopicNames(names: readonly string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}

/** "AI" · "AI, Automation" — the names a notice reports, alphabetical. */
export function topicListLabel(names: readonly string[]): string {
  return sortTopicNames(names).join(", ");
}

/** The inbox line (and the e-mail's first line): only the topics the recipient follows. */
export function topicNoticeMessage(input: { topics: readonly string[]; number: string | number; title: string }): string {
  return `New in ${topicListLabel(input.topics)}: ${formatChallengeNumber(input.number)} "${input.title}" is open for solutions.`;
}

/** The e-mail subject. */
export function topicNoticeSubject(topics: readonly string[], number: string | number): string {
  return `New in ${topicListLabel(topics)}: ${formatChallengeNumber(number)} is open for solutions`;
}

/** The e-mail's closing line, before the link to `/topics`. */
export function topicNoticeFootnote(topics: readonly string[]): string {
  return `You get this because you follow ${topicListLabel(topics)}. Manage your topics:`;
}

/** The digest's line for an event-18 row (§12.1). */
export function topicDigestLine(topics: readonly string[]): string {
  return `New in a topic you follow — ${topicListLabel(topics)}`;
}

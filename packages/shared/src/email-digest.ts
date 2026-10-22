// E-mail digests (INNOBOX_SPEC.md §12.1) — pure and CLIENT-SAFE (also exposed at
// `@innobox/shared/email-digest` for the profile page's "Next digest" line). A user may swap the
// per-event e-mails about what they follow for one summary e-mail a day or a week. This module
// owns the choice, which events a digest may hold, the fixed send slots, and the digest's copy;
// the hold at insert time lives in the web tier (lib/notify.ts) and the send in the worker.
import { topicDigestLine } from "./topics.js";

export const EMAIL_DELIVERY_MODES = ["immediate", "daily", "weekly"] as const;
export type EmailDelivery = (typeof EMAIL_DELIVERY_MODES)[number];
/** The two digest cadences — every mode but `immediate`. */
export type DigestCadence = Exclude<EmailDelivery, "immediate">;

export const EMAIL_DELIVERY_LABEL: Record<EmailDelivery, string> = {
  immediate: "Immediately",
  daily: "Daily digest",
  weekly: "Weekly digest",
};

export function isEmailDelivery(v: unknown): v is EmailDelivery {
  return typeof v === "string" && (EMAIL_DELIVERY_MODES as readonly string[]).includes(v);
}

// ── Which events a digest covers ─────────────────────────────────────────────────────────

/** The §12.1 event-matrix rows, by number. */
export type NotificationEventNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18;

/** The follower-type events: 2 (new solution), 3 (status changed), 6 (comments), 8 (implemented),
 *  16 (hyped — §26.6 treats it as follower-type for the digest, not as actionable) and 18 (a new
 *  challenge in a topic the recipient follows, §34.5). */
const DIGESTABLE_EVENTS: ReadonlySet<NotificationEventNumber> = new Set([2, 3, 6, 8, 16, 18]);

/**
 * True when an event may be held for a recipient's digest. Only the follower-type events are; a
 * recipient on the ADMIN route (namespace admins and the committee on a new solution) is an
 * attention event and always immediate, as are the actionable author/assignee events (4, 5, 7,
 * 11, 12), the admin events (1, 9, 10, 14) and event 13, which has no e-mail at all.
 */
export function isDigestableEvent(event: NotificationEventNumber, onAdminRoute = false): boolean {
  return DIGESTABLE_EVENTS.has(event) && !onAdminRoute;
}

// ── Send slots ───────────────────────────────────────────────────────────────────────────

/** Daily at 06:00 UTC; weekly on Mondays at 06:00 UTC. Fixed for the whole platform. */
export const DIGEST_SLOT_HOUR_UTC = 6;
const MONDAY = 1;

/** The next send slot strictly after `now`: a row written at 06:00 exactly, or just after, waits
 *  for the following slot — a day later, or a week later on a Monday. */
export function nextDigestSlot(cadence: DigestCadence, now: Date): Date {
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DIGEST_SLOT_HOUR_UTC));
  if (slot.getTime() <= now.getTime()) slot.setUTCDate(slot.getUTCDate() + 1);
  if (cadence === "weekly") {
    while (slot.getUTCDay() !== MONDAY) slot.setUTCDate(slot.getUTCDate() + 1);
  }
  return slot;
}

// ── The digest's content ─────────────────────────────────────────────────────────────────

/** At most this many items are listed; the rest are summed up in one closing line. */
export const DIGEST_MAX_ITEMS = 25;

export type DigestKind = "solution" | "status" | "comment" | "implemented" | "hype" | "topic";

/** What a held outbox row carries for the digest (payload.digest), written at insert time. */
export interface DigestFacts {
  kind: DigestKind;
  /** The challenge the update is grouped under — digits only. */
  challengeNumber: string;
  challengeTitle: string;
  /** A status change on a solution, or the implemented solution — digits only. */
  solutionNumber?: string | null;
  /** The new status's label, for a status change. */
  statusLabel?: string | null;
  /** §34.5 event 18: the followed topics the challenge opened in. */
  topics?: string[] | null;
}

/** One held row, as the digest job hands it to the renderer. */
export interface DigestUpdate extends DigestFacts {
  /** How many updates the row stands for — a coalesced comment row counts all its comments. */
  count: number;
  /** When the row was last active (a coalesced comment row's latest comment). */
  at: Date;
}

export interface RenderedDigest {
  subject: string;
  /** Plain text — the transport escapes it and links only the app's own URLs. */
  text: string;
  updateCount: number;
  itemCount: number;
}

const digitsOf = (n: string): string => n.replace(/\D/g, "");
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The lines for one item, in a fixed order: implemented, new solutions, status changes (the
 *  challenge's, then each solution's), comments. Status lines name the latest status. */
function itemLines(updates: readonly DigestUpdate[]): string[] {
  const lines: string[] = [];
  // §34.5: a challenge new in a followed topic leads its block — it is why the item is there.
  const topics = new Set(updates.filter((u) => u.kind === "topic").flatMap((u) => u.topics ?? []));
  if (topics.size > 0) lines.push(topicDigestLine([...topics]));
  const implemented = updates.filter((u) => u.kind === "implemented");
  for (const u of implemented) {
    lines.push(u.solutionNumber ? `Solution SOL-${digitsOf(u.solutionNumber)} was implemented` : "A solution was implemented");
  }
  const solutions = updates.filter((u) => u.kind === "solution").reduce((n, u) => n + u.count, 0);
  if (solutions > 0) lines.push(plural(solutions, "new solution", "new solutions"));

  const statusBySubject = new Map<string, DigestUpdate[]>();
  for (const u of updates.filter((x) => x.kind === "status")) {
    const key = u.solutionNumber ? digitsOf(u.solutionNumber) : "";
    statusBySubject.set(key, [...(statusBySubject.get(key) ?? []), u]);
  }
  const subjects = [...statusBySubject.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : Number(a) - Number(b)));
  for (const key of subjects) {
    const group = statusBySubject.get(key)!;
    const count = group.reduce((n, u) => n + u.count, 0);
    const latest = group.reduce((a, b) => (b.at.getTime() >= a.at.getTime() ? b : a));
    const now = latest.statusLabel ? ` — now ${oneLine(latest.statusLabel)}` : "";
    lines.push(`${key ? `SOL-${key}: ` : ""}${plural(count, "status change", "status changes")}${now}`);
  }

  const comments = updates.filter((u) => u.kind === "comment").reduce((n, u) => n + u.count, 0);
  if (comments > 0) lines.push(plural(comments, "new comment", "new comments"));

  // §26.6: hypes on the challenge itself, then on each of its solutions — one line per item.
  const hypeBySubject = new Map<string, number>();
  for (const u of updates.filter((x) => x.kind === "hype")) {
    const key = u.solutionNumber ? digitsOf(u.solutionNumber) : "";
    hypeBySubject.set(key, (hypeBySubject.get(key) ?? 0) + u.count);
  }
  const hypeSubjects = [...hypeBySubject.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : Number(a) - Number(b)));
  for (const key of hypeSubjects) {
    lines.push(`${key ? `SOL-${key}: ` : ""}${plural(hypeBySubject.get(key)!, "new hype", "new hypes")}`);
  }
  return lines;
}

/**
 * The digest e-mail: updates grouped by challenge, most recently active first, at most
 * DIGEST_MAX_ITEMS items and then one "and K more" line. It names no author and quotes no comment
 * or description — only numbers, titles, counts and status labels. `cadence` null is the one-off
 * digest sent when a user switches back to immediate delivery. Null when there is nothing to send.
 */
export function renderDigest(updates: readonly DigestUpdate[], cadence: DigestCadence | null, baseUrl: string): RenderedDigest | null {
  if (updates.length === 0) return null;
  const byItem = new Map<string, DigestUpdate[]>();
  for (const u of updates) {
    const key = digitsOf(u.challengeNumber);
    byItem.set(key, [...(byItem.get(key) ?? []), u]);
  }
  const lastActive = (group: readonly DigestUpdate[]) => Math.max(...group.map((u) => u.at.getTime()));
  const items = [...byItem.entries()].sort(([, a], [, b]) => lastActive(b) - lastActive(a));

  const updateCount = updates.reduce((n, u) => n + u.count, 0);
  const base = baseUrl.replace(/\/$/, "");
  const blocks = items.slice(0, DIGEST_MAX_ITEMS).map(([number, group]) => {
    const newest = group.reduce((a, b) => (b.at.getTime() >= a.at.getTime() ? b : a));
    const heading = `CH-${number} — ${oneLine(newest.challengeTitle)}`;
    return [heading, `${base}/challenges/${number}`, ...itemLines(group).map((l) => `- ${l}`)].join("\n");
  });
  const more = items.length - DIGEST_MAX_ITEMS;
  if (more > 0) blocks.push(`and ${more} more — open InnoBox to see everything\n${base}/`);

  const label = cadence ? `${cadence} ` : "";
  const intro = cadence
    ? `Here is your ${cadence} summary of what happened on the items you follow.`
    : "Here are the updates held for your digest.";
  return {
    subject: `Your ${label}InnoBox digest — ${plural(updateCount, "update", "updates")}`,
    text: [intro, ...blocks].join("\n\n"),
    updateCount,
    itemCount: items.length,
  };
}

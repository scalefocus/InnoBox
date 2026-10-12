// What's new — the update notice and the page's "New since your last visit" (INNOBOX_SPEC.md
// §13.9). Pure and dependency-free: the AppShell notice, the /whats-new page and the stamp
// endpoint all share these rules, and the unit suite pins them without a DOM or a database.
//
// Versions are strict `x.y.z` (non-negative integers, no leading zeros, no prefix or suffix).
// Anything else — a stored marker, a `?since=` value, a bundle constant — is treated as absent.

/** The changelog fields these rules read (app/whats-new/changelog.ts satisfies it). */
export interface ReleaseEntry {
  version: string;
  date: string; // UTC calendar date, YYYY-MM-DD
}

/** The excerpt shows at most this many entries; the link's count covers all of them. */
export const NOTICE_EXCERPT_MAX = 3;

/** `?since=0.0.0` — every entry counts as missed. */
export const SINCE_ALL = "0.0.0";

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `[major, minor, patch]` for a strict `x.y.z`, else null. */
export function parseVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const m = VERSION_RE.exec(value);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number];
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function isVersion(value: unknown): value is string {
  return parseVersion(value) !== null;
}

/** Negative, zero or positive as `a` is lower than, equal to or greater than `b`. Both must be
 *  strict versions — callers validate first. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`compareVersions: not a strict x.y.z version (${a}, ${b})`);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  }
  return 0;
}

/** True for a real `YYYY-MM-DD` calendar date (rejects 2026-02-30). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** A stored marker as the rules see it: the version when strict, otherwise null. */
export function normalizeMarker(value: unknown): string | null {
  return isVersion(value) ? value : null;
}

/**
 * The trigger rule, evaluated client-side against the client bundle's APP_VERSION. Every
 * release notifies — patch, minor and major alike — and several skipped releases still make one
 * notice. A rollback or a stale cached bundle (`seen` at or above `current`) shows nothing.
 */
export function whatsNewAction(seen: unknown, current: string, quickStartSeen: boolean): "show" | "none" {
  if (!quickStartSeen) return "none"; // the onboarding gate owns this load
  if (!isVersion(current)) return "none";
  const marker = normalizeMarker(seen);
  if (marker === null) return "show";
  return compareVersions(marker, current) < 0 ? "show" : "none";
}

/** Where "missed" starts: after a version, or on/after a calendar date. */
export type MissedBoundary = { kind: "version"; version: string } | { kind: "date"; date: string };

/** Entries past the boundary, in changelog order (newest first). */
export function entriesPast<T extends ReleaseEntry>(entries: readonly T[], boundary: MissedBoundary): T[] {
  if (boundary.kind === "version") {
    return entries.filter((e) => isVersion(e.version) && compareVersions(e.version, boundary.version) > 0);
  }
  // YYYY-MM-DD compares correctly as a string.
  return entries.filter((e) => e.date >= boundary.date);
}

/**
 * The notice's missed entries: past a valid marker; else, while the marker is null, everything
 * dated on or after the rollout boundary; else the current version's entry alone. A rollout date
 * later than every entry (the user was active after the current release was dated) also falls
 * back to the current entry, so a notice that is due never comes up empty.
 */
export function missedEntries<T extends ReleaseEntry>(
  entries: readonly T[],
  opts: { seen: unknown; sinceDate: unknown; current: string },
): T[] {
  const marker = normalizeMarker(opts.seen);
  if (marker !== null) return entriesPast(entries, { kind: "version", version: marker });
  if (isCalendarDate(opts.sinceDate)) {
    const dated = entriesPast(entries, { kind: "date", date: opts.sinceDate });
    if (dated.length > 0) return dated;
  }
  return entries.filter((e) => e.version === opts.current);
}

/** The notice's excerpt: the newest missed entries, capped by count (never by length). */
export function noticeExcerpt<T>(missed: readonly T[]): T[] {
  return missed.slice(0, NOTICE_EXCERPT_MAX);
}

/**
 * The link's `?since=`: the newest entry that was NOT missed, or `0.0.0` when every entry was —
 * so the page highlights exactly what the notice counted, even after the link's own stamp.
 */
export function sinceForLink(entries: readonly ReleaseEntry[], missed: readonly ReleaseEntry[]): string {
  const missedVersions = new Set(missed.map((e) => e.version));
  const newestUnmissed = entries.find((e) => !missedVersions.has(e.version) && isVersion(e.version));
  return newestUnmissed ? newestUnmissed.version : SINCE_ALL;
}

/** The link's label: the count of all missed entries, or the plain form for the current alone. */
export function noticeLinkLabel(missed: readonly ReleaseEntry[], current: string): string {
  if (missed.length === 1 && missed[0]!.version === current) return "See what's new";
  return `See what's new since your last visit (${missed.length})`;
}

/**
 * The page's boundary, in order: a valid `?since=`; else the marker as read before the page's
 * own mount stamp; else, while that marker is null, the rollout date. Null → render plainly.
 */
export function resolvePageBoundary(opts: {
  since: unknown;
  markerBeforeStamp: unknown;
  sinceDate: unknown;
}): MissedBoundary | null {
  if (isVersion(opts.since)) return { kind: "version", version: opts.since };
  const marker = normalizeMarker(opts.markerBeforeStamp);
  if (marker !== null) return { kind: "version", version: marker };
  if (isCalendarDate(opts.sinceDate)) return { kind: "date", date: opts.sinceDate };
  return null;
}

/**
 * Whether a client may stamp `version` against the server's APP_VERSION: strict, and not in the
 * future. Returns the validated version, or null (→ 400).
 */
export function validStampVersion(version: unknown, serverVersion: string): string | null {
  if (!isVersion(version) || !isVersion(serverVersion)) return null;
  return compareVersions(version, serverVersion) <= 0 ? version : null;
}

/** Whether a stamp of `next` should replace `stored`: null, invalid or strictly lower only. */
export function stampAdvances(stored: unknown, next: string): boolean {
  const marker = normalizeMarker(stored);
  return marker === null || compareVersions(marker, next) < 0;
}

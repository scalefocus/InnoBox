// The §12.2 pulse — one poll per tab for every live counter the shell shows (INNOBOX_SPEC.md §12.2,
// v1.18): the bell's unread count, the §13.1 new-challenges bubble, the §14.4 triage attention
// bubble and the §14.6 system banner. Pure helpers shared by the route, the shell hook and tests —
// no React, no DB.
import type { SystemBanner } from "@innobox/shared/system-banner";

export interface Pulse {
  unreadCount: number;
  newChallenges: number;
  /** null for anyone who is not a namespace or platform admin — the key is always present. */
  attention: number | null;
  banner: SystemBanner | null;
}

export const PULSE_INTERVAL_MS = 30_000;

/** Window events that ask the shell to re-read the pulse at once instead of at the next tick
 *  (§12.2 *Immediate refresh*). The first three predate the pulse and keep their names. */
export const PULSE_REFRESH_EVENTS = [
  "innobox:pulse", // mark-read / mark-all-read in the bell
  "innobox:banner-changed", // the admin saved or cleared the §14.6 banner
  "innobox:triage-seen", // the triage queue stamped triage_seen_at (§14.4 clearing)
  "innobox:challenges-seen", // leaving the Challenges surface advanced the §13.1 marker
] as const;

export const EMPTY_PULSE: Pulse = { unreadCount: 0, newChallenges: 0, attention: null, banner: null };

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/** Reads a pulse response defensively: anything malformed degrades to "nothing to show". */
export function parsePulse(json: unknown): Pulse {
  const o = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const b = o.banner as Record<string, unknown> | null | undefined;
  const banner =
    b && typeof b === "object" && typeof b.message === "string" && typeof b.expiresAt === "string"
      ? (b as unknown as SystemBanner)
      : null;
  return {
    unreadCount: count(o.unreadCount),
    newChallenges: count(o.newChallenges),
    attention: o.attention === null || o.attention === undefined ? null : count(o.attention),
    banner,
  };
}

function sameBanner(a: SystemBanner | null, b: SystemBanner | null): boolean {
  if (a === null || b === null) return a === b;
  return a.message === b.message && a.tone === b.tone && a.url === b.url && a.expiresAt === b.expiresAt;
}

/** §12.2 *No needless re-render*: true when a fresh pulse shows exactly what the shell already has. */
export function samePulse(a: Pulse, b: Pulse): boolean {
  return a.unreadCount === b.unreadCount && a.newChallenges === b.newChallenges && a.attention === b.attention && sameBanner(a.banner, b.banner);
}

/** §12.2 *Cadence*: a tab that becomes visible polls at once when its last pulse is older than the
 *  interval (or it never had one); otherwise it just resumes the cadence. */
export function shouldPollOnVisible(lastPulseAt: number | null, now: number, intervalMs: number = PULSE_INTERVAL_MS): boolean {
  return lastPulseAt === null || now - lastPulseAt >= intervalMs;
}

/** §12.2 *Failure*: what a pulse response means for the poller. A 401 ends the session — stop; any
 *  other non-2xx keeps the last values and retries on the next tick. */
export function pulseOutcome(status: number): "apply" | "stop" | "keep" {
  if (status >= 200 && status < 300) return "apply";
  if (status === 401) return "stop";
  return "keep";
}

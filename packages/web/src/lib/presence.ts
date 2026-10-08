// Presence logic — pure, dependency-free, unit-tested (INNOBOX_SPEC.md §14.5).
// Deliberately holds NO database or next/* imports so presence.test.ts can exercise the
// allowlist and the masking rules in isolation; the write path is lib/presence-touch.ts and
// the read path is api/admin/presence/store.ts.

/** The online-list windows offered by the panel. 5m is the default (§14.5). */
export const PRESENCE_WINDOWS = ["5m", "1h", "8h", "24h", "30d"] as const;
export type PresenceWindow = (typeof PRESENCE_WINDOWS)[number];
export const DEFAULT_PRESENCE_WINDOW: PresenceWindow = "5m";

const WINDOW_SECONDS: Record<PresenceWindow, number> = {
  "5m": 5 * 60,
  "1h": 60 * 60,
  "8h": 8 * 60 * 60,
  "24h": 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
};

/** Prose for the panel's window line, so the copy can never drift from the query. */
const WINDOW_PHRASE: Record<PresenceWindow, string> = {
  "5m": "the last 5 minutes",
  "1h": "the last hour",
  "8h": "the last 8 hours",
  "24h": "the last 24 hours",
  "30d": "the last 30 days",
};

export function parsePresenceWindow(raw: string | null | undefined): PresenceWindow {
  return (PRESENCE_WINDOWS as readonly string[]).includes(raw ?? "")
    ? (raw as PresenceWindow)
    : DEFAULT_PRESENCE_WINDOW;
}

export function windowSeconds(w: PresenceWindow): number {
  return WINDOW_SECONDS[w];
}

export function windowPhrase(w: PresenceWindow): string {
  return WINDOW_PHRASE[w];
}

/** Chart ranges. "all" = everything retained in presence_daily (kept indefinitely). */
export const PRESENCE_RANGES = ["7d", "30d", "90d", "all"] as const;
export type PresenceRange = (typeof PRESENCE_RANGES)[number];
export const DEFAULT_PRESENCE_RANGE: PresenceRange = "30d";

/** Days of history a range covers, or null for "all" (no lower bound). */
export function rangeDays(r: PresenceRange): number | null {
  return r === "all" ? null : Number(r.replace("d", ""));
}

export function parsePresenceRange(raw: string | null | undefined): PresenceRange {
  return (PRESENCE_RANGES as readonly string[]).includes(raw ?? "")
    ? (raw as PresenceRange)
    : DEFAULT_PRESENCE_RANGE;
}

/** Below this many points the chart is replaced by the "not enough history yet" note —
 *  the series only starts the day tracking shipped, and there is no backfill (§14.5). */
export const MIN_CHART_POINTS = 7;

/** The most users one window response will ever carry (§14.5). */
export const PRESENCE_LIST_CAP = 200;

/** One write per user per 60 s: the throttle that keeps the stamp off the hot path (§14.5).
 *  Caps timestamp precision at a minute, which the relative "48m ago" copy tolerates. */
export const PRESENCE_THROTTLE_MS = 60_000;

// ---------------------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------------------
// EXPLICIT ALLOWLIST, never a denylist (§14.5): a path that isn't listed here is silent.
// A future polling widget therefore cannot quietly pollute presence by being forgotten —
// the failure mode is an under-count, which is the safe direction. The two pollers that
// exist today (GET /api/notifications on the bell's 30 s cadence, §12.2, and
// GET /api/admin/triage/attention on the same cadence, §14.4) are absent by construction:
// counting them would make "online" mean "left a tab open", and every user who ever opened
// InnoBox would read as permanently active.
//
// Two tiers:
//   "locate" — the request tells us where the user is; it stamps last_seen_at AND last_route.
//   "touch"  — user-initiated but location-less (posting a comment, toggling a like); it
//              stamps last_seen_at and LEAVES last_route alone, so the panel keeps showing
//              the page they are actually on rather than blanking it.

export type PresenceTouch =
  | { tier: "locate"; route: string }
  | { tier: "touch" };

/** Location tokens stored in users.last_route. Opaque on the write path; resolved and
 *  masked at read time. Entity tokens are `challenge:<number>` / `solution:<number>`. */
export const ROUTE_OVERVIEW = "overview";
export const ROUTE_CHALLENGES = "challenges";
export const ROUTE_SOLUTIONS = "solutions";
export const ROUTE_SEARCH = "search";
export const ROUTE_LEADERBOARD = "leaderboard";
export const ROUTE_PROFILE = "profile";
export const ROUTE_TRIAGE = "triage";
export const ROUTE_ADMIN = "administration";
export const ROUTE_WHATS_NEW = "whats-new";
export const ROUTE_NOTIFICATIONS = "notifications";

/** Human labels for the category tokens. Entity tokens are labelled by the store, which
 *  has the title (and the anonymity flag that may mask it away). */
const ROUTE_LABEL: Record<string, string> = {
  [ROUTE_OVERVIEW]: "Overview",
  [ROUTE_CHALLENGES]: "Challenges",
  [ROUTE_SOLUTIONS]: "Solutions",
  [ROUTE_SEARCH]: "Search",
  [ROUTE_LEADERBOARD]: "Leaderboard",
  [ROUTE_PROFILE]: "Profile",
  [ROUTE_TRIAGE]: "Triage",
  [ROUTE_ADMIN]: "Administration",
  [ROUTE_WHATS_NEW]: "What's new",
  [ROUTE_NOTIFICATIONS]: "Notifications",
};

function entityToken(kind: "challenge" | "solution", segment: string): string | null {
  // Accept "412" and "CH-412"/"SOL-412" alike — the number is what the store looks up.
  const n = Number(/^(?:CH-|SOL-)?(\d+)$/i.exec(segment)?.[1]);
  return Number.isInteger(n) && n > 0 ? `${kind}:${n}` : null;
}

/** Splits "challenge:412" into its parts; null for a category token. */
export function parseEntityRoute(route: string): { kind: "challenge" | "solution"; number: number } | null {
  const m = /^(challenge|solution):(\d+)$/.exec(route);
  return m ? { kind: m[1] as "challenge" | "solution", number: Number(m[2]) } : null;
}

/** The label for a category token; null if it isn't one (i.e. it's an entity token). */
export function categoryLabel(route: string | null): string | null {
  return route ? (ROUTE_LABEL[route] ?? null) : null;
}

/**
 * The allowlist itself: what a request to `pathname` (with `method`) means for presence.
 * Returns null for everything not explicitly listed — pollers, avatar/card gateways, form
 * metadata, and any route added later that nobody thought about.
 */
export function presenceTouchFor(pathname: string, method: string): PresenceTouch | null {
  if (!pathname.startsWith("/api/")) return null;
  const segments = pathname.slice("/api/".length).split("/").filter(Boolean);
  const [head, second, third] = segments;
  const isRead = method === "GET" || method === "HEAD";

  switch (head) {
    // ── Located ───────────────────────────────────────────────────────────────────────
    case "dashboard":
      return { tier: "locate", route: ROUTE_OVERVIEW };
    case "search":
      return { tier: "locate", route: ROUTE_SEARCH };
    case "leaderboards":
      return { tier: "locate", route: ROUTE_LEADERBOARD };
    case "profile":
      return { tier: "locate", route: ROUTE_PROFILE };

    case "challenges": {
      // POST /api/challenges is a SUBMISSION, and it is deliberately located at the bare
      // category, never at the challenge it just created: "X was on the new-challenge form"
      // plus an anonymous challenge appearing moments later is the §9 correlation with
      // extra steps (§14.5).
      if (!second) return { tier: "locate", route: ROUTE_CHALLENGES };
      const token = entityToken("challenge", second);
      // A nested solutions listing (…/challenges/412/solutions) is still "on CH-412".
      return token ? { tier: "locate", route: token } : { tier: "locate", route: ROUTE_CHALLENGES };
    }

    case "solutions": {
      if (!second) return { tier: "locate", route: ROUTE_SOLUTIONS };
      const token = entityToken("solution", second);
      return token ? { tier: "locate", route: token } : { tier: "locate", route: ROUTE_SOLUTIONS };
    }

    case "admin": {
      // The attention badge polls on the bell's cadence — excluded (§14.4).
      if (second === "triage" && third === "attention") return null;
      if (second === "triage") return { tier: "locate", route: ROUTE_TRIAGE };
      // Everything else under /api/admin is the console: namespaces, role mappings,
      // settings, audit, presence itself. An admin refreshing the panel IS active.
      return { tier: "locate", route: ROUTE_ADMIN };
    }

    // ── Activity only (no location) ────────────────────────────────────────────────────
    // These are unambiguously user-initiated but say nothing about *where* the user is:
    // the request carries the parent in its body, not its path. Stamping the timestamp and
    // leaving last_route alone keeps the panel showing the page they are actually on.
    case "comments":
    case "likes":
    case "follows":
      return { tier: "touch" };

    case "notifications":
      // GET is the 30-second bell poll — silent. A PATCH is a human marking one read.
      return isRead ? null : { tier: "touch" };

    case "attachments":
      // An upload is a human act; a GET through the gateway is not necessarily one (inline
      // previews fire on render), and /attachments/config is form metadata.
      return isRead ? null : { tier: "touch" };

    // ── Silent by construction ────────────────────────────────────────────────────────
    // users/:id/photo + users/:id/card fire en masse from avatar bubbles and hover cards
    // (§3.1, §13.8); me / impact-areas / namespaces are app-shell and form metadata that
    // load without anyone doing anything.
    default:
      return null;
  }
}
// ---------------------------------------------------------------------------------------

/** "just now" / "48m ago" / "3h ago" / "5d ago" for the row pills. Timezone-free by
 *  construction — a difference of two instants needs no locale (cf. §13.6 DateFormat,
 *  which handles absolute timestamps). */
export function relativeActive(lastSeenIso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - new Date(lastSeenIso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The UTC day a timestamp falls in, as `YYYY-MM-DD` — the chart's bucket key (invariant 8). */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

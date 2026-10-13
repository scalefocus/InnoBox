// Gamification: points, levels & badges (INNOBOX_SPEC.md §23) — the pure, CLIENT-SAFE half
// (also exposed at `@innobox/shared/gamification`). Weights, daily caps, the level curve and the
// badge catalogue are fixed here in code (§23.1 decision 7): there is no admin tuning. The DB
// writer that applies them inside a triggering transaction is the server-only
// `gamification-awards.ts`.

// ── Points (§23.2) ───────────────────────────────────────────────────────────────────────

export const GAMIFICATION_REASONS = [
  "challenge_submitted",
  "challenge_validated",
  "challenge_solved",
  "assignment_solved",
  "solution_proposed",
  "solution_validated",
  "solution_implemented",
  "like_received",
  "comment_posted",
  // §25.12: 0 points, once per person, the first time they approve an AI agent connection. The
  // only reason with no item.
  "agent_connected",
] as const;
export type GamificationReason = (typeof GAMIFICATION_REASONS)[number];

export const POINTS: Record<GamificationReason, number> = {
  challenge_submitted: 5,
  challenge_validated: 20,
  challenge_solved: 15,
  assignment_solved: 15,
  solution_proposed: 5,
  solution_validated: 20,
  solution_implemented: 50,
  like_received: 1,
  comment_posted: 1,
  agent_connected: 0,
};

/** Per recipient, per UTC day of the event: only the first N awards of the reason earn points.
 *  Past the cap the row is still written, with 0 points (§23.2). */
export const DAILY_CAPS: Partial<Record<GamificationReason, number>> = {
  comment_posted: 5,
  like_received: 25,
};

/** The points one award is worth, given how many awards of the same reason the recipient
 *  already has on the event's UTC day. */
export function pointsFor(reason: GamificationReason, sameDayCountBefore: number): number {
  const cap = DAILY_CAPS[reason];
  if (cap !== undefined && sameDayCountBefore >= cap) return 0;
  return POINTS[reason];
}

/** The UTC calendar day an event falls on, as [start, end) — the window the daily caps count in. */
export function utcDayBounds(at: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

export type AwardItemType = "challenge" | "solution";

/** The once-per-item award keys (§23.2) — unique per `(user, award key)`, which is what makes
 *  every milestone first-entry-only and every retry idempotent. */
export const awardKey = {
  challengeSubmitted: (challengeId: string) => `challenge_submitted:${challengeId}`,
  challengeValidated: (challengeId: string) => `challenge_validated:${challengeId}`,
  challengeSolved: (challengeId: string) => `challenge_solved:${challengeId}`,
  assignmentSolved: (challengeId: string) => `assignment_solved:${challengeId}`,
  solutionProposed: (solutionId: string) => `solution_proposed:${solutionId}`,
  solutionValidated: (solutionId: string) => `solution_validated:${solutionId}`,
  solutionImplemented: (solutionId: string) => `solution_implemented:${solutionId}`,
  likeReceived: (parentType: AwardItemType, parentId: string, likerId: string) => `like_received:${parentType}:${parentId}:${likerId}`,
  commentPosted: (commentId: string) => `comment_posted:${commentId}`,
  /** §25.12: once per person, ever. */
  agentConnected: () => "agent_connected",
};

// ── Levels (§23.3) ───────────────────────────────────────────────────────────────────────

export const LEVELS = [
  { level: 1, name: "Newcomer", threshold: 0 },
  { level: 2, name: "Contributor", threshold: 25 },
  { level: 3, name: "Explorer", threshold: 75 },
  { level: 4, name: "Problem Solver", threshold: 150 },
  { level: 5, name: "Innovator", threshold: 300 },
  { level: 6, name: "Catalyst", threshold: 500 },
  { level: 7, name: "Trailblazer", threshold: 800 },
  { level: 8, name: "Visionary", threshold: 1200 },
  { level: 9, name: "Pioneer", threshold: 1800 },
  { level: 10, name: "Luminary", threshold: 2500 },
] as const;
export const MAX_LEVEL = LEVELS[LEVELS.length - 1]!.level;

export interface LevelInfo {
  level: number;
  levelName: string;
  /** 0…1 toward the next level; 1 at the top level, which has no next. */
  progress: number;
  /** The next level's name and how many points it still needs; null at the top. */
  next: { level: number; name: string; pointsNeeded: number } | null;
}

/** Levels are computed from the total on read, never stored (§23.3). */
export function levelFor(points: number): LevelInfo {
  const total = Math.max(0, Math.floor(points));
  let index = 0;
  for (let i = 0; i < LEVELS.length; i++) if (total >= LEVELS[i]!.threshold) index = i;
  const current = LEVELS[index]!;
  const nextLevel = LEVELS[index + 1];
  if (!nextLevel) return { level: current.level, levelName: current.name, progress: 1, next: null };
  const span = nextLevel.threshold - current.threshold;
  return {
    level: current.level,
    levelName: current.name,
    progress: Math.min(1, Math.max(0, (total - current.threshold) / span)),
    next: { level: nextLevel.level, name: nextLevel.name, pointsNeeded: nextLevel.threshold - total },
  };
}

/** The levels newly reached between two totals (both inclusive of the higher end), in order. */
export function levelsReached(before: number, after: number): number[] {
  const from = levelFor(before).level;
  const to = levelFor(after).level;
  const out: number[] = [];
  for (let level = from + 1; level <= to; level++) out.push(level);
  return out;
}

export function levelName(level: number): string {
  return LEVELS.find((l) => l.level === level)?.name ?? "";
}

// ── Achievement badges (§23.4) ───────────────────────────────────────────────────────────

export type BadgeKey =
  | "problem_spotter"
  | "solution_architect"
  | "implementer"
  | "challenge_closer"
  | "champion"
  | "crowd_favorite"
  | "conversation_starter"
  | "icebreaker"
  | "first_idea"
  | "full_circle"
  | "plugged_in"
  | "co_pilot"
  | "agent_of_change"
  | "human_in_the_loop";

/** What a count-based badge counts: a ledger reason, or one of the §25.12 agent counters — rows
 *  of the given reasons whose item was created through an AI agent (`via_mcp`). */
export type BadgeCounter = GamificationReason | "challenge_submitted_via_mcp" | "solution_proposed_via_mcp" | "validated_via_mcp";

/** The ledger rows each counter counts — the one definition the SQL counts are built from. */
export const BADGE_COUNTERS: Record<BadgeCounter, { reasons: readonly GamificationReason[]; viaMcp: boolean | null }> = {
  challenge_submitted: { reasons: ["challenge_submitted"], viaMcp: null },
  challenge_validated: { reasons: ["challenge_validated"], viaMcp: null },
  challenge_solved: { reasons: ["challenge_solved"], viaMcp: null },
  assignment_solved: { reasons: ["assignment_solved"], viaMcp: null },
  solution_proposed: { reasons: ["solution_proposed"], viaMcp: null },
  solution_validated: { reasons: ["solution_validated"], viaMcp: null },
  solution_implemented: { reasons: ["solution_implemented"], viaMcp: null },
  like_received: { reasons: ["like_received"], viaMcp: null },
  comment_posted: { reasons: ["comment_posted"], viaMcp: null },
  agent_connected: { reasons: ["agent_connected"], viaMcp: null },
  challenge_submitted_via_mcp: { reasons: ["challenge_submitted"], viaMcp: true },
  solution_proposed_via_mcp: { reasons: ["solution_proposed"], viaMcp: true },
  validated_via_mcp: { reasons: ["challenge_validated", "solution_validated"], viaMcp: true },
};

export interface BadgeDef {
  key: BadgeKey;
  name: string;
  /** The criterion, in user terms, shown on a locked badge and as the tooltip. */
  criterion: string;
  /** What the badge counts (a ledger reason or a §25.12 agent counter); null for Full Circle,
   *  which is a cross-item check. */
  counts: BadgeCounter | null;
  /** Tier thresholds (Bronze, Silver, Gold) for a tiered badge; one entry for a one-off. */
  thresholds: readonly number[];
  /** The counted unit for the progress line ("3 of 5 challenges validated"). */
  unit: string;
  /** §25.12: an agent badge — shown among the locked badges only while agent access is on. */
  agent?: boolean;
}

export const BADGES: readonly BadgeDef[] = [
  { key: "problem_spotter", name: "Problem Spotter", criterion: "Challenges you wrote that were validated", counts: "challenge_validated", thresholds: [1, 5, 15], unit: "challenges validated" },
  { key: "solution_architect", name: "Solution Architect", criterion: "Solutions you wrote that were validated", counts: "solution_validated", thresholds: [1, 5, 15], unit: "solutions validated" },
  { key: "implementer", name: "Implementer", criterion: "Solutions you wrote that were implemented", counts: "solution_implemented", thresholds: [1, 3, 10], unit: "solutions implemented" },
  { key: "challenge_closer", name: "Challenge Closer", criterion: "Challenges you wrote that were solved", counts: "challenge_solved", thresholds: [1, 3, 10], unit: "challenges solved" },
  { key: "champion", name: "Champion", criterion: "Challenges solved while you were the assignee", counts: "assignment_solved", thresholds: [1, 5, 15], unit: "assigned challenges solved" },
  { key: "crowd_favorite", name: "Crowd Favorite", criterion: "Likes received from other people", counts: "like_received", thresholds: [10, 50, 200], unit: "likes received" },
  { key: "conversation_starter", name: "Conversation Starter", criterion: "Comments posted", counts: "comment_posted", thresholds: [10, 50, 200], unit: "comments posted" },
  { key: "icebreaker", name: "Icebreaker", criterion: "Your first challenge submitted", counts: "challenge_submitted", thresholds: [1], unit: "challenges submitted" },
  { key: "first_idea", name: "First Idea", criterion: "Your first solution proposed", counts: "solution_proposed", thresholds: [1], unit: "solutions proposed" },
  { key: "full_circle", name: "Full Circle", criterion: "A solution you wrote was implemented on a challenge you also wrote", counts: null, thresholds: [1], unit: "" },
  { key: "plugged_in", name: "Plugged In", criterion: "Your first AI agent connected", counts: "agent_connected", thresholds: [1], unit: "agents connected", agent: true },
  { key: "co_pilot", name: "Co-Pilot", criterion: "Your first challenge submitted through an agent", counts: "challenge_submitted_via_mcp", thresholds: [1], unit: "challenges submitted through an agent", agent: true },
  { key: "agent_of_change", name: "Agent of Change", criterion: "Your first solution proposed through an agent", counts: "solution_proposed_via_mcp", thresholds: [1], unit: "solutions proposed through an agent", agent: true },
  { key: "human_in_the_loop", name: "Human in the Loop", criterion: "A challenge or solution you submitted through an agent was validated", counts: "validated_via_mcp", thresholds: [1], unit: "agent submissions validated", agent: true },
];

export function badgeDef(key: string): BadgeDef | undefined {
  return BADGES.find((b) => b.key === key);
}

export function isTiered(badge: BadgeDef): boolean {
  return badge.thresholds.length > 1;
}

export const TIER_NAMES: Record<1 | 2 | 3, string> = { 1: "Bronze", 2: "Silver", 3: "Gold" };

/** A badge's display name with its tier — "Implementer (Silver)", or just "Icebreaker". */
export function badgeLabel(key: string, tier: number | null): string {
  const def = badgeDef(key);
  const name = def?.name ?? key;
  return tier === 1 || tier === 2 || tier === 3 ? `${name} (${TIER_NAMES[tier]})` : name;
}

export type ReasonCounts = Partial<Record<BadgeCounter, number>>;

/** Every (badge, tier) the counts reach — each tier separately, so a multi-tier jump inserts all
 *  of them (§23.4). Full Circle is not count-based and is evaluated by the caller. */
export function badgeTiersReached(counts: ReasonCounts): { badgeKey: BadgeKey; tier: 1 | 2 | 3 | null }[] {
  const out: { badgeKey: BadgeKey; tier: 1 | 2 | 3 | null }[] = [];
  for (const badge of BADGES) {
    if (!badge.counts) continue;
    const count = counts[badge.counts] ?? 0;
    if (!isTiered(badge)) {
      if (count >= badge.thresholds[0]!) out.push({ badgeKey: badge.key, tier: null });
      continue;
    }
    badge.thresholds.forEach((threshold, i) => {
      if (count >= threshold) out.push({ badgeKey: badge.key, tier: (i + 1) as 1 | 2 | 3 });
    });
  }
  return out;
}

/** Progress toward a badge's next step, for the owner's view: `null` when it is fully earned or
 *  not count-based. */
export function badgeProgress(badge: BadgeDef, counts: ReasonCounts): { current: number; target: number; label: string } | null {
  if (!badge.counts) return null;
  const current = counts[badge.counts] ?? 0;
  const target = badge.thresholds.find((t) => current < t);
  if (target === undefined) return null;
  return { current, target, label: `${current} of ${target} ${badge.unit}` };
}

// ── Leader badges (§23.5) ────────────────────────────────────────────────────────────────

export const LEADER_METRICS = ["solutions_implemented", "challenges_submitted", "solutions_proposed", "likes_received", "points"] as const;
export type LeaderMetric = (typeof LEADER_METRICS)[number];

export const LEADER_GLYPH: Record<LeaderMetric, { glyph: string; label: string; color: string }> = {
  solutions_implemented: { glyph: "🚀", label: "Solutions implemented", color: "var(--accent)" },
  challenges_submitted: { glyph: "💡", label: "Challenges submitted", color: "var(--accent-2)" },
  solutions_proposed: { glyph: "🧩", label: "Solutions proposed", color: "var(--ok)" },
  likes_received: { glyph: "❤️", label: "Likes received", color: "var(--warn)" },
  points: { glyph: "⭐", label: "Points", color: "var(--accent)" },
};

export interface LeaderBadge {
  metric: LeaderMetric;
  window: "30d" | "all";
}

/** Tooltip and aria-label: "Points leader — all time" / "… — last 30 days". */
export function leaderBadgeLabel(badge: LeaderBadge): string {
  return `${LEADER_GLYPH[badge.metric].label} leader — ${badge.window === "all" ? "all time" : "last 30 days"}`;
}

/** Everyone tied at the single highest value — the contiguous prefix of a ranked board sharing
 *  the top row's count. Nobody leads a board whose top is zero or that is empty. */
export function leadersOf<T extends { userId: string; count: number }>(ranked: readonly T[]): string[] {
  const top = ranked[0];
  if (!top || top.count <= 0) return [];
  const out: string[] = [];
  for (const row of ranked) {
    if (row.count !== top.count) break;
    out.push(row.userId);
  }
  return out;
}

// ── Achievement notification (§23.7) ─────────────────────────────────────────────────────

export type Achievement = { kind: "badge"; badgeKey: string; tier: number | null } | { kind: "level"; level: number };

/** Highest tier per badge, in first-seen order; only the highest level. A multi-tier jump in one
 *  transaction reads as the tier it ended on. */
function summarize(items: readonly Achievement[]): { badges: { badgeKey: string; tier: number | null }[]; level: number | null } {
  const badges: { badgeKey: string; tier: number | null }[] = [];
  let level: number | null = null;
  for (const item of items) {
    if (item.kind === "level") {
      level = level === null ? item.level : Math.max(level, item.level);
      continue;
    }
    const existing = badges.find((b) => b.badgeKey === item.badgeKey);
    if (!existing) badges.push({ badgeKey: item.badgeKey, tier: item.tier });
    else if ((item.tier ?? 0) > (existing.tier ?? 0)) existing.tier = item.tier;
  }
  return { badges, level };
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The inbox row and toast copy: "You earned Implementer (Silver) and reached level 5 — Innovator."
 *  Empty input yields "". */
export function achievementMessage(items: readonly Achievement[]): string {
  const { badges, level } = summarize(items);
  const earned = joinList(badges.map((b) => badgeLabel(b.badgeKey, b.tier)));
  const reached = level !== null ? `level ${level} — ${levelName(level)}` : "";
  if (earned && reached) return `You earned ${earned} and reached ${reached}.`;
  if (earned) return `You earned ${earned}.`;
  if (reached) return `You reached ${reached}.`;
  return "";
}

// ── Profile preferences (§23.7, §23.9) ───────────────────────────────────────────────────

export interface GamificationPreferences {
  gamificationPublic: boolean;
  notifyAchievements: boolean;
}

export const GAMIFICATION_PREFERENCE_KEYS = ["gamificationPublic", "notifyAchievements"] as const;

/** The two gamification switches of a `PATCH profile` body, each a boolean when present. Unknown
 *  keys are ignored; an empty result is fine (the caller decides whether anything was asked). */
export function parseGamificationPreferences(body: Record<string, unknown>): { ok: true; value: Partial<GamificationPreferences> } | { ok: false; error: string } {
  const value: Partial<GamificationPreferences> = {};
  for (const key of GAMIFICATION_PREFERENCE_KEYS) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") return { ok: false, error: `${key} must be a boolean` };
    value[key] = body[key] as boolean;
  }
  return { ok: true, value };
}

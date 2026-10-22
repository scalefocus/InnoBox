// The read side of §23 (INNOBOX_SPEC.md §23.5–§23.7, §23.9, §23.12): the gamification blocks the
// `me`, `profile`, `profile/:userId`, `users/:id/card` and `leaderboards` payloads carry. Every
// block is `null` while the feature is off; another person's block is also `null` when they hide
// their gamification (their own view always shows everything). No block ever names an item, a
// namespace or a ledger row — that is what lets restricted work count (decision 5).
// Relative imports only (no `@/`) so the gated dbtests can load it.
import type { Pool } from "pg";
import {
  BADGES,
  LEADER_METRICS,
  LEADERBOARD_WINDOWS,
  TIER_NAMES,
  badgeProgress,
  getGamificationSettings,
  leadersOf,
  levelFor,
  levelsReached,
  reasonCounts,
  type Achievement,
  type LeaderBadge,
  type LevelInfo,
} from "@innobox/shared";
import { getCachedLeaderboard } from "../app/api/leaderboards/store";
import { getMcpSettings } from "./mcp/store";
import { getHypeEnabled } from "./hype-settings";
import { getFeatureIdeasEnabled } from "@innobox/shared";

export async function isGamificationOn(pool: Pool): Promise<boolean> {
  return (await getGamificationSettings(pool)).enabled;
}

export interface LevelBlock extends LevelInfo {
  points: number;
}

export interface EarnedBadge {
  badgeKey: string;
  name: string;
  criterion: string;
  /** The highest tier held (null for a one-off). */
  tier: 1 | 2 | 3 | null;
  tierName: string | null;
  /** When the highest tier was earned. */
  earnedAt: string;
  /** Every tier held, each with its own earned date. */
  tiers: { tier: 1 | 2 | 3 | null; earnedAt: string }[];
  /** Own view only: the line toward the next tier ("7 of 15 challenges validated"). */
  progress?: string | null;
}

export interface LockedBadge {
  badgeKey: string;
  name: string;
  criterion: string;
  progress: string | null;
}

export interface OwnGamification extends LevelBlock {
  leading: LeaderBadge[];
  earned: EarnedBadge[];
  locked: LockedBadge[];
}

export interface PublicGamification extends LevelBlock {
  leading: LeaderBadge[];
  earned: EarnedBadge[];
}

export interface CardGamification {
  level: number;
  levelName: string;
  progress: number;
  leading: LeaderBadge[];
  /** The 3 most recently earned badges, highest tier each. */
  recentBadges: { badgeKey: string; name: string; tier: 1 | 2 | 3 | null; tierName: string | null }[];
}

/** The level total: the user's points over all their ledger rows, all time (§23.2). */
export async function pointsTotals(pool: Pool, userIds: readonly string[]): Promise<Map<string, number>> {
  const totals = new Map<string, number>(userIds.map((id) => [id, 0]));
  if (userIds.length === 0) return totals;
  const { rows } = await pool.query<{ user_id: string; total: string }>(
    `select user_id, sum(points)::text as total from gamification_ledger where user_id = any($1::uuid[]) group by user_id`,
    [userIds],
  );
  for (const r of rows) totals.set(r.user_id, Number(r.total));
  return totals;
}

async function levelBlock(pool: Pool, userId: string): Promise<LevelBlock> {
  const points = (await pointsTotals(pool, [userId])).get(userId) ?? 0;
  return { points, ...levelFor(points) };
}

/** True when the user lets others see their level and badges (§23.9). */
async function isPublic(pool: Pool, userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ gamification_public: boolean }>(`select gamification_public from users where id = $1`, [userId]);
  return rows[0]?.gamification_public ?? false;
}

/** The (metric, window) boards this user currently tops, from the cached §13.3 boards (§23.5). */
export async function leadingFor(pool: Pool, userId: string): Promise<LeaderBadge[]> {
  const out: LeaderBadge[] = [];
  for (const metric of LEADER_METRICS) {
    for (const window of LEADERBOARD_WINDOWS) {
      const board = await getCachedLeaderboard(pool, metric, window);
      if (leadersOf(board).includes(userId)) out.push({ metric, window });
    }
  }
  return out;
}

/** Earned badges, newest first, each at its highest tier with every tier's own date. */
async function earnedBadges(pool: Pool, userId: string): Promise<EarnedBadge[]> {
  const { rows } = await pool.query<{ badge_key: string; tier: 1 | 2 | 3 | null; earned_at: Date }>(
    `select badge_key, tier, earned_at from user_badges where user_id = $1 order by earned_at`,
    [userId],
  );
  const byKey = new Map<string, EarnedBadge>();
  for (const r of rows) {
    const def = BADGES.find((b) => b.key === r.badge_key);
    if (!def) continue; // a key no longer in the catalogue renders nothing
    const entry = byKey.get(r.badge_key) ?? {
      badgeKey: def.key,
      name: def.name,
      criterion: def.criterion,
      tier: null,
      tierName: null,
      earnedAt: r.earned_at.toISOString(),
      tiers: [],
    };
    entry.tiers.push({ tier: r.tier, earnedAt: r.earned_at.toISOString() });
    if ((r.tier ?? 0) >= (entry.tier ?? 0)) {
      entry.tier = r.tier;
      entry.tierName = r.tier ? TIER_NAMES[r.tier] : null;
      entry.earnedAt = r.earned_at.toISOString();
    }
    byKey.set(r.badge_key, entry);
  }
  return [...byKey.values()].sort((a, b) => (a.earnedAt < b.earnedAt ? 1 : a.earnedAt > b.earnedAt ? -1 : 0));
}

/** The owner's full block: level, leading, earned (with progress) and locked badges. */
export async function ownGamification(pool: Pool, userId: string): Promise<OwnGamification | null> {
  if (!(await isGamificationOn(pool))) return null;
  const [level, leading, earned, counts, mcp, hypeOn, ideasOn] = await Promise.all([
    levelBlock(pool, userId),
    leadingFor(pool, userId),
    earnedBadges(pool, userId),
    reasonCounts(pool, userId),
    getMcpSettings(pool),
    getHypeEnabled(pool),
    getFeatureIdeasEnabled(pool),
  ]);
  const earnedKeys = new Set(earned.map((b) => b.badgeKey));
  for (const badge of earned) {
    const def = BADGES.find((b) => b.key === badge.badgeKey)!;
    badge.progress = badgeProgress(def, counts)?.label ?? null;
  }
  // §25.12: the four agent badges appear among the locked ones only while agent access is on;
  // earned ones always show.
  // §26.8: likewise Talent Scout only while hype is on, and §38.10 Roadmapper while feature ideas are.
  const locked = BADGES.filter((b) => !earnedKeys.has(b.key) && (!b.agent || mcp.enabled) && (!b.hype || hypeOn) && (!b.featureIdeas || ideasOn)).map((b) => ({
    badgeKey: b.key,
    name: b.name,
    criterion: b.criterion,
    progress: badgeProgress(b, counts)?.label ?? null,
  }));
  return { ...level, leading, earned, locked };
}

/** What another viewer sees: level, leading and earned badges — no locked ones, no progress. */
export async function publicGamification(pool: Pool, userId: string): Promise<PublicGamification | null> {
  if (!(await isGamificationOn(pool)) || !(await isPublic(pool, userId))) return null;
  const [level, leading, earned] = await Promise.all([levelBlock(pool, userId), leadingFor(pool, userId), earnedBadges(pool, userId)]);
  return { ...level, leading, earned };
}

/** The hover card's block (§13.8), or null when off or hidden. */
export async function cardGamification(pool: Pool, userId: string): Promise<CardGamification | null> {
  if (!(await isGamificationOn(pool)) || !(await isPublic(pool, userId))) return null;
  const [level, leading, earned] = await Promise.all([levelBlock(pool, userId), leadingFor(pool, userId), earnedBadges(pool, userId)]);
  return {
    level: level.level,
    levelName: level.levelName,
    progress: level.progress,
    leading,
    recentBadges: earned.slice(0, 3).map((b) => ({ badgeKey: b.badgeKey, name: b.name, tier: b.tier, tierName: b.tierName })),
  };
}

/** The `me` block for the sidebar ring — your own, so never masked by the opt-out. */
export async function meGamification(pool: Pool, userId: string): Promise<{ points: number; level: number; levelName: string; progress: number } | null> {
  if (!(await isGamificationOn(pool))) return null;
  const level = await levelBlock(pool, userId);
  return { points: level.points, level: level.level, levelName: level.levelName, progress: level.progress };
}

/**
 * §23.7 toast: badge tiers and levels earned after max(achievements_seen_at,
 * gamification_enabled_at) — so enabling the feature never floods anyone with old news. Empty
 * while the feature is off or the Achievements preference is off. A level counts as earned when
 * the points written after that moment carried the total across its threshold.
 */
export async function newAchievements(pool: Pool, userId: string): Promise<Achievement[]> {
  const settings = await getGamificationSettings(pool);
  if (!settings.enabled) return [];
  const { rows } = await pool.query<{ notify_achievements: boolean; achievements_seen_at: Date | null }>(
    `select notify_achievements, achievements_seen_at from users where id = $1`,
    [userId],
  );
  const user = rows[0];
  if (!user || !user.notify_achievements) return [];
  const marks = [user.achievements_seen_at, settings.enabledAt].filter((d): d is Date => d !== null);
  if (marks.length === 0) return [];
  const since = new Date(Math.max(...marks.map((d) => d.getTime())));

  const [{ rows: badges }, { rows: totals }] = await Promise.all([
    pool.query<{ badge_key: string; tier: number | null }>(
      `select badge_key, tier from user_badges where user_id = $1 and earned_at > $2 order by earned_at, badge_key, tier`,
      [userId, since],
    ),
    pool.query<{ before: string; total: string }>(
      `select coalesce(sum(points) filter (where created_at <= $2), 0)::text as before, coalesce(sum(points), 0)::text as total
         from gamification_ledger where user_id = $1`,
      [userId, since],
    ),
  ]);
  return [
    ...badges.map((b) => ({ kind: "badge" as const, badgeKey: b.badge_key, tier: b.tier })),
    ...levelsReached(Number(totals[0]?.before ?? 0), Number(totals[0]?.total ?? 0)).map((level) => ({ kind: "level" as const, level })),
  ];
}

/** `POST me/achievements-seen`: advances the toast marker. Own-account housekeeping — not audited. */
export async function markAchievementsSeen(pool: Pool, userId: string): Promise<void> {
  await pool.query(`update users set achievements_seen_at = greatest(coalesce(achievements_seen_at, '-infinity'::timestamptz), now()) where id = $1`, [userId]);
}

/** Leaderboard rows' level chips: `{ level, progress }` per user, null when hidden or off. */
export async function levelChips(pool: Pool, userIds: readonly string[]): Promise<Map<string, { level: number; progress: number } | null>> {
  const out = new Map<string, { level: number; progress: number } | null>(userIds.map((id) => [id, null]));
  if (userIds.length === 0 || !(await isGamificationOn(pool))) return out;
  const [totals, { rows }] = await Promise.all([
    pointsTotals(pool, userIds),
    pool.query<{ id: string }>(`select id from users where id = any($1::uuid[]) and gamification_public`, [userIds]),
  ]);
  for (const { id } of rows) {
    const info = levelFor(totals.get(id) ?? 0);
    out.set(id, { level: info.level, progress: info.progress });
  }
  return out;
}

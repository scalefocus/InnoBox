// Gamification award writer (INNOBOX_SPEC.md §23.2, §23.4, §23.7, §23.8) — SERVER-ONLY. One
// implementation for both tiers: the web calls it inside every triggering transaction (create,
// status transition, like, comment, self-reveal), the worker's one-time backfill (§23.11) calls it
// per user. DB access is the structural DbClient shape, so a pg Pool or a checked-out PoolClient
// both satisfy it.
//
// Rules applied here:
//   - one row per (user, award key), `ON CONFLICT DO NOTHING` — retries and races never double-award;
//   - a transaction-scoped advisory lock per recipient, so two concurrent comments can't both slip
//     under the daily cap;
//   - daily caps per UTC day of the EVENT (occurred_at), with 0-point rows past the cap;
//   - badge tiers re-evaluated from the ledger after any insert, each tier reached inserted;
//   - one §12.1 event 13 inbox row per call (= per triggering transaction) listing everything it
//     earned — in-app only (no outbox row), gated by notify_achievements and the platform switch.
// Nothing is ever deducted or deleted here (§23.1 decision 3); the only DELETE is the §3 erasure.
import type { DbClient } from "./email-graph.js";
import {
  BADGES,
  BADGE_COUNTERS,
  achievementMessage,
  awardKey,
  badgeTiersReached,
  levelsReached,
  pointsFor,
  utcDayBounds,
  DAILY_CAPS,
  type Achievement,
  type AwardItemType,
  type BadgeCounter,
  type BadgeKey,
  type GamificationReason,
  type ReasonCounts,
} from "./gamification.js";

export interface AwardInput {
  userId: string;
  reason: GamificationReason;
  /** Null exactly for the item-less `agent_connected` reason (§25.12). */
  itemType: AwardItemType | null;
  itemId: string | null;
  awardKey: string;
  /** §25.12 `via_mcp`: whether the item (or comment) the award is about was created through an AI
   *  agent. When omitted it is read from the item's `mcp_client_name` — so a replay or a later
   *  milestone copies it from the item. A comment award passes it from the comment itself. */
  viaMcp?: boolean;
  /** The event time — drives the daily cap day and the 30-day window. Defaults to now. */
  occurredAt?: Date;
}

export interface WriteAwardsOptions {
  /** Write the event 13 inbox row (live triggers and the self-reveal replay). The backfill passes
   *  false — it is silent (§23.11). */
  notify: boolean;
  /** A badge's earned_at: "now" for live awards and replays (so they toast), "event" — the time
   *  of the award that reached the tier — for the backfill. */
  earnedAt?: "now" | "event";
  /** Re-evaluate badges even when this call inserted nothing (the backfill's crash-resume). */
  evaluateAlways?: boolean;
}

export interface AwardOutcome {
  /** Ledger rows actually inserted. */
  awards: number;
  /** (badge, tier) rows actually inserted. */
  badges: number;
  /** Users who received at least one new ledger row. */
  users: number;
}

// ── Platform switch (§23.10) ─────────────────────────────────────────────────────────────

export const GAMIFICATION_ENABLED_KEY = "gamification_enabled";
export const GAMIFICATION_ENABLED_AT_KEY = "gamification_enabled_at";
export const GAMIFICATION_BACKFILLED_AT_KEY = "gamification_backfilled_at";

export interface GamificationSettings {
  enabled: boolean;
  /** Stamped on each off → on flip; the toast never reports anything earned before it. */
  enabledAt: Date | null;
  backfilledAt: Date | null;
}

function asDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function getGamificationSettings(db: DbClient): Promise<GamificationSettings> {
  const { rows } = await db.query<{ key: string; value: unknown }>(`select key, value from platform_settings where key = any($1::text[])`, [
    [GAMIFICATION_ENABLED_KEY, GAMIFICATION_ENABLED_AT_KEY, GAMIFICATION_BACKFILLED_AT_KEY],
  ]);
  const get = (key: string) => rows.find((r) => r.key === key)?.value;
  return {
    enabled: get(GAMIFICATION_ENABLED_KEY) === true,
    enabledAt: asDate(get(GAMIFICATION_ENABLED_AT_KEY)),
    backfilledAt: asDate(get(GAMIFICATION_BACKFILLED_AT_KEY)),
  };
}

// ── Award writing ────────────────────────────────────────────────────────────────────────

/** Serializes award writing per recipient until the transaction ends. */
async function lockRecipient(db: DbClient, userId: string): Promise<void> {
  await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`gamification:${userId}`]);
}

async function totalPoints(db: DbClient, userId: string): Promise<number> {
  const { rows } = await db.query<{ total: string | null }>(`select coalesce(sum(points), 0)::text as total from gamification_ledger where user_id = $1`, [userId]);
  return Number(rows[0]?.total ?? 0);
}

async function insertAward(db: DbClient, award: AwardInput): Promise<boolean> {
  const at = award.occurredAt ?? new Date();
  let sameDay = 0;
  if (DAILY_CAPS[award.reason] !== undefined) {
    const { start, end } = utcDayBounds(at);
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from gamification_ledger
        where user_id = $1 and reason = $2 and occurred_at >= $3 and occurred_at < $4`,
      [award.userId, award.reason, start, end],
    );
    sameDay = rows[0]?.n ?? 0;
  }
  const result = await db.query(
    `insert into gamification_ledger (user_id, reason, points, award_key, item_type, item_id, occurred_at, via_mcp)
     values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::boolean,
       case $5::text
         when 'challenge' then (select mcp_client_name is not null from challenges where id = $6::uuid)
         when 'solution' then (select mcp_client_name is not null from solutions where id = $6::uuid)
       end, false))
     on conflict (user_id, award_key) do nothing`,
    [award.userId, award.reason, pointsFor(award.reason, sameDay), award.awardKey, award.itemType, award.itemId, at, award.viaMcp ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

/** The ledger counts per reason — and per §25.12 agent counter — that badges evaluate (capped
 *  0-point rows included). */
export async function reasonCounts(db: DbClient, userId: string): Promise<ReasonCounts> {
  const { rows } = await db.query<{ reason: GamificationReason; via_mcp: boolean; n: number }>(
    `select reason, via_mcp, count(*)::int as n from gamification_ledger where user_id = $1 group by reason, via_mcp`,
    [userId],
  );
  const counts: ReasonCounts = {};
  for (const [counter, def] of Object.entries(BADGE_COUNTERS) as [BadgeCounter, (typeof BADGE_COUNTERS)[BadgeCounter]][]) {
    const n = rows
      .filter((r) => def.reasons.includes(r.reason) && (def.viaMcp === null || r.via_mcp === def.viaMcp))
      .reduce((sum, r) => sum + r.n, 0);
    if (n > 0) counts[counter] = n;
  }
  return counts;
}

/** Full Circle (§23.4): a solution the user wrote was implemented (an award row exists) on a
 *  challenge they also wrote and hold an award row for. Returns the qualifying event time. */
async function fullCircleAt(db: DbClient, userId: string): Promise<Date | null> {
  const { rows } = await db.query<{ at: Date | null }>(
    `select min(gl.occurred_at) as at
       from gamification_ledger gl
       join solutions s on s.id = gl.item_id
       join challenges c on c.id = s.challenge_id
      where gl.user_id = $1 and gl.reason = 'solution_implemented' and c.author_id = $1
        and exists (select 1 from gamification_ledger g2
                     where g2.user_id = $1 and g2.item_type = 'challenge' and g2.item_id = c.id
                       and g2.reason = 'challenge_submitted')`,
    [userId],
  );
  return rows[0]?.at ?? null;
}

/** The event time of the Nth row a counter counts — when a count-based tier was reached. */
async function nthAwardAt(db: DbClient, userId: string, counter: BadgeCounter, n: number): Promise<Date | null> {
  const def = BADGE_COUNTERS[counter];
  const { rows } = await db.query<{ occurred_at: Date }>(
    `select occurred_at from gamification_ledger
      where user_id = $1 and reason = any($2::text[]) and ($3::boolean is null or via_mcp = $3)
      order by occurred_at, id offset $4 limit 1`,
    [userId, def.reasons, def.viaMcp, n - 1],
  );
  return rows[0]?.occurred_at ?? null;
}

/** Inserts every newly reached (badge, tier) for the user and returns them. */
export async function evaluateBadges(db: DbClient, userId: string, earnedAt: "now" | "event" = "now"): Promise<{ badgeKey: BadgeKey; tier: 1 | 2 | 3 | null }[]> {
  const counts = await reasonCounts(db, userId);
  const reached = badgeTiersReached(counts);
  const { rows: held } = await db.query<{ badge_key: string; tier: number | null }>(`select badge_key, tier from user_badges where user_id = $1`, [userId]);
  const has = (key: string, tier: number | null) => held.some((h) => h.badge_key === key && (h.tier ?? 0) === (tier ?? 0));

  const candidates: { badgeKey: BadgeKey; tier: 1 | 2 | 3 | null; at: Date | null }[] = [];
  for (const r of reached) {
    if (has(r.badgeKey, r.tier)) continue;
    let at: Date | null = null;
    if (earnedAt === "event") {
      const def = BADGES.find((b) => b.key === r.badgeKey)!;
      at = await nthAwardAt(db, userId, def.counts!, def.thresholds[(r.tier ?? 1) - 1]!);
    }
    candidates.push({ ...r, at });
  }
  if ((counts.solution_implemented ?? 0) > 0 && !has("full_circle", null)) {
    const at = await fullCircleAt(db, userId);
    if (at) candidates.push({ badgeKey: "full_circle", tier: null, at: earnedAt === "event" ? at : null });
  }

  const inserted: { badgeKey: BadgeKey; tier: 1 | 2 | 3 | null }[] = [];
  for (const c of candidates) {
    const result = await db.query(
      `insert into user_badges (user_id, badge_key, tier, earned_at) values ($1, $2, $3, coalesce($4::timestamptz, now()))
       on conflict do nothing`,
      [userId, c.badgeKey, c.tier, c.at],
    );
    if ((result.rowCount ?? 0) > 0) inserted.push({ badgeKey: c.badgeKey, tier: c.tier });
  }
  return inserted;
}

/** §12.1 event 13: one in-app row per triggering transaction, no outbox row. Written only while
 *  the feature is on and the earner keeps the Achievements preference on. */
async function notifyAchievements(db: DbClient, userId: string, items: Achievement[]): Promise<void> {
  if (items.length === 0) return;
  const settings = await getGamificationSettings(db);
  if (!settings.enabled) return;
  const { rows } = await db.query<{ on: boolean }>(`select notify_achievements as on from users where id = $1`, [userId]);
  if (!rows[0]?.on) return;
  await db.query(`insert into notifications (user_id, type, payload) values ($1, 'achievement_earned', $2)`, [
    userId,
    JSON.stringify({ message: achievementMessage(items), link: "/profile" }),
  ]);
}

/**
 * Writes a batch of awards inside the caller's transaction (the caller owns BEGIN/COMMIT; a
 * failed award fails the action). Recipients are locked in a fixed order, awards within a
 * recipient are written in event order so the daily caps keep "the first N of the day".
 */
export async function writeAwards(db: DbClient, awards: readonly AwardInput[], opts: WriteAwardsOptions): Promise<AwardOutcome> {
  const outcome: AwardOutcome = { awards: 0, badges: 0, users: 0 };
  const now = new Date();
  const byUser = new Map<string, AwardInput[]>();
  for (const a of awards) byUser.set(a.userId, [...(byUser.get(a.userId) ?? []), { ...a, occurredAt: a.occurredAt ?? now }]);

  for (const userId of [...byUser.keys()].sort()) {
    await lockRecipient(db, userId);
    const before = await totalPoints(db, userId);
    const list = byUser.get(userId)!.slice().sort((a, b) => a.occurredAt!.getTime() - b.occurredAt!.getTime());
    let inserted = 0;
    for (const award of list) if (await insertAward(db, award)) inserted++;
    if (inserted === 0 && !opts.evaluateAlways) continue;

    outcome.awards += inserted;
    if (inserted > 0) outcome.users++;
    const badges = await evaluateBadges(db, userId, opts.earnedAt ?? "now");
    outcome.badges += badges.length;
    if (!opts.notify) continue;
    const after = inserted > 0 ? await totalPoints(db, userId) : before;
    const items: Achievement[] = [
      ...badges.map((b) => ({ kind: "badge" as const, badgeKey: b.badgeKey, tier: b.tier })),
      ...levelsReached(before, after).map((level) => ({ kind: "level" as const, level })),
    ];
    await notifyAchievements(db, userId, items);
  }
  return outcome;
}

// ── Milestone replay (self-reveal §9 and the backfill §23.11) ────────────────────────────

/** The first time an item entered a status, from its `*.status_changed` audit rows. */
async function firstEntryAt(db: DbClient, itemType: AwardItemType, itemId: string, status: string): Promise<Date | null> {
  const { rows } = await db.query<{ at: Date | null }>(
    `select min(created_at) as at from audit_log
      where target_type = $1 and target_id = $2 and action = $3 and after->>'status' = $4`,
    [itemType, itemId, `${itemType}.status_changed`, status],
  );
  return rows[0]?.at ?? null;
}

/**
 * Every award a challenge has already earned, with its original event time: for the author
 * (submitted, validated, solved, and one like_received per current like by someone else) and,
 * when asked, for its current assignee (assignment_solved — the history of who held the
 * assignment at the solve is not reconstructed). Milestone times come from the first matching
 * status audit row, falling back to first_valid_at / resolved_at / status_changed_at.
 */
export async function challengeAwardsSoFar(
  db: DbClient,
  challengeId: string,
  opts: { author: boolean; assignee: boolean },
): Promise<AwardInput[]> {
  const { rows } = await db.query<{
    author_id: string | null;
    assignee_id: string | null;
    status: string;
    created_at: Date;
    first_valid_at: Date | null;
    resolved_at: Date | null;
    status_changed_at: Date | null;
  }>(`select author_id, assignee_id, status, created_at, first_valid_at, resolved_at, status_changed_at from challenges where id = $1`, [challengeId]);
  const c = rows[0];
  if (!c) return [];
  const validAt = (await firstEntryAt(db, "challenge", challengeId, "valid")) ?? c.first_valid_at;
  const solvedAt =
    (await firstEntryAt(db, "challenge", challengeId, "solved")) ?? (c.status === "solved" ? (c.resolved_at ?? c.status_changed_at ?? c.created_at) : null);
  const item = { itemType: "challenge" as const, itemId: challengeId };
  const out: AwardInput[] = [];
  // §24.6: an external challenge has no author — only its assignee's award applies.
  if (opts.author && c.author_id !== null) {
    out.push({ ...item, userId: c.author_id, reason: "challenge_submitted", awardKey: awardKey.challengeSubmitted(challengeId), occurredAt: c.created_at });
    if (validAt) out.push({ ...item, userId: c.author_id, reason: "challenge_validated", awardKey: awardKey.challengeValidated(challengeId), occurredAt: validAt });
    if (solvedAt) out.push({ ...item, userId: c.author_id, reason: "challenge_solved", awardKey: awardKey.challengeSolved(challengeId), occurredAt: solvedAt });
    out.push(...(await likeAwards(db, "challenge", challengeId, c.author_id)));
    out.push(...(await hypeAwards(db, "challenge", challengeId, c.author_id)));
  }
  if (opts.assignee && solvedAt && c.assignee_id && c.assignee_id !== c.author_id) {
    out.push({ ...item, userId: c.assignee_id, reason: "assignment_solved", awardKey: awardKey.assignmentSolved(challengeId), occurredAt: solvedAt });
  }
  return out;
}

/** Every award a solution's author has already earned (proposed, validated, implemented, likes). */
export async function solutionAwardsSoFar(db: DbClient, solutionId: string): Promise<AwardInput[]> {
  const { rows } = await db.query<{ author_id: string; status: string; created_at: Date; status_changed_at: Date | null }>(
    `select author_id, status, created_at, status_changed_at from solutions where id = $1`,
    [solutionId],
  );
  const s = rows[0];
  if (!s) return [];
  const fallback = (status: string) => (s.status === status ? (s.status_changed_at ?? s.created_at) : null);
  const validAt = (await firstEntryAt(db, "solution", solutionId, "valid")) ?? fallback("valid");
  const implementedAt = (await firstEntryAt(db, "solution", solutionId, "implemented")) ?? fallback("implemented");
  const item = { itemType: "solution" as const, itemId: solutionId, userId: s.author_id };
  const out: AwardInput[] = [{ ...item, reason: "solution_proposed", awardKey: awardKey.solutionProposed(solutionId), occurredAt: s.created_at }];
  if (validAt) out.push({ ...item, reason: "solution_validated", awardKey: awardKey.solutionValidated(solutionId), occurredAt: validAt });
  if (implementedAt) out.push({ ...item, reason: "solution_implemented", awardKey: awardKey.solutionImplemented(solutionId), occurredAt: implementedAt });
  out.push(...(await likeAwards(db, "solution", solutionId, s.author_id)));
  out.push(...(await hypeAwards(db, "solution", solutionId, s.author_id)));
  return out;
}

/** §26.7: one hype_received per existing hype, backdated to the hype — what a self-reveal replays.
 *  Self-hype is refused at the API, so the author filter is belt and braces. */
async function hypeAwards(db: DbClient, parentType: AwardItemType, parentId: string, authorId: string): Promise<AwardInput[]> {
  const { rows } = await db.query<{ user_id: string; created_at: Date }>(
    `select user_id, created_at from hypes where parent_type = $1 and parent_id = $2 and user_id <> $3`,
    [parentType, parentId, authorId],
  );
  return rows.map((h) => ({
    userId: authorId,
    reason: "hype_received" as const,
    itemType: parentType,
    itemId: parentId,
    awardKey: awardKey.hypeReceived(parentType, parentId, h.user_id),
    occurredAt: h.created_at,
  }));
}

/** One like_received per current like by someone other than the author. */
async function likeAwards(db: DbClient, parentType: AwardItemType, parentId: string, authorId: string): Promise<AwardInput[]> {
  const { rows } = await db.query<{ user_id: string; created_at: Date }>(
    `select user_id, created_at from likes where parent_type = $1 and parent_id = $2 and user_id <> $3`,
    [parentType, parentId, authorId],
  );
  return rows.map((l) => ({
    userId: authorId,
    reason: "like_received" as const,
    itemType: parentType,
    itemId: parentId,
    awardKey: awardKey.likeReceived(parentType, parentId, l.user_id),
    occurredAt: l.created_at,
  }));
}

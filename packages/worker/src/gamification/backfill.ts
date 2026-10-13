// The one-time gamification backfill (INNOBOX_SPEC.md §23.11): replays the existing history into
// the ledger under §23.2's rules, run by the leader when `gamification_backfilled_at` is null.
//
//   - challenges and solutions: creation, and the first entry into valid / solved / implemented
//     (from the *.status_changed audit rows, falling back to first_valid_at / status_changed_at);
//   - the challenge's CURRENT assignee for assignment_solved — the history of who held the
//     assignment at the solve is not reconstructed (the assignee is never anonymous, §23.2);
//   - likes by someone other than the author, and non-deleted comments;
//   - anonymous items' author awards are skipped (a later self-reveal replays them);
//   - §25.12: `via_mcp` copied from each item (from the comment itself for comment_posted), and one
//     0-point `agent_connected` per person from their earliest AI agent grant.
// Every row keeps its original occurred_at and the daily caps apply per original day (the shared
// writer inserts in event order). Badges are evaluated for every user, with each tier dated by the
// award that reached it; NO notification is written. Then the job stamps gamification_backfilled_at,
// sets every user's toast marker to now (so the rollout never toasts old news), and writes one
// `gamification.backfilled` audit row (actor system, counts only). Idempotent by award key: a crash
// mid-run is resumed by the next start.
import type { Pool } from "pg";
import {
  GAMIFICATION_BACKFILLED_AT_KEY,
  appendAudit,
  awardKey,
  challengeAwardsSoFar,
  getGamificationSettings,
  solutionAwardsSoFar,
  writeAwards,
  type AwardInput,
} from "@innobox/shared";

export interface BackfillSummary {
  ran: boolean;
  users: number;
  awards: number;
  badges: number;
}

/** Collects every award the existing history has earned, grouped by recipient. */
async function collectAwards(pool: Pool): Promise<Map<string, AwardInput[]>> {
  const byUser = new Map<string, AwardInput[]>();
  const add = (awards: AwardInput[]) => {
    for (const a of awards) byUser.set(a.userId, [...(byUser.get(a.userId) ?? []), a]);
  };

  const { rows: challenges } = await pool.query<{ id: string; is_anonymous: boolean }>(`select id, is_anonymous from challenges order by created_at`);
  for (const c of challenges) add(await challengeAwardsSoFar(pool, c.id, { author: !c.is_anonymous, assignee: true }));

  const { rows: solutions } = await pool.query<{ id: string }>(`select id from solutions where is_anonymous = false order by created_at`);
  for (const s of solutions) add(await solutionAwardsSoFar(pool, s.id));

  const { rows: comments } = await pool.query<{
    id: string;
    author_id: string;
    parent_type: "challenge" | "solution";
    parent_id: string;
    created_at: Date;
    via_mcp: boolean;
  }>(
    `select id, author_id, parent_type, parent_id, created_at, mcp_client_name is not null as via_mcp
       from comments where deleted_at is null order by created_at`,
  );
  add(
    comments.map((c) => ({
      userId: c.author_id,
      reason: "comment_posted" as const,
      itemType: c.parent_type,
      itemId: c.parent_id,
      awardKey: awardKey.commentPosted(c.id),
      occurredAt: c.created_at,
      viaMcp: c.via_mcp,
    })),
  );

  // §25.12: Plugged In's ledger row, dated by the person's earliest grant (revoked ones included).
  const { rows: grants } = await pool.query<{ user_id: string; first_at: Date }>(
    `select user_id, min(created_at) as first_at from oauth_grants group by user_id`,
  );
  add(
    grants.map((g) => ({
      userId: g.user_id,
      reason: "agent_connected" as const,
      itemType: null,
      itemId: null,
      awardKey: awardKey.agentConnected(),
      occurredAt: g.first_at,
      viaMcp: true,
    })),
  );
  return byUser;
}

export async function runGamificationBackfill(pool: Pool): Promise<BackfillSummary> {
  const settings = await getGamificationSettings(pool);
  if (settings.backfilledAt) return { ran: false, users: 0, awards: 0, badges: 0 };

  const byUser = await collectAwards(pool);
  const summary: BackfillSummary = { ran: true, users: 0, awards: 0, badges: 0 };
  // One transaction per recipient: the writer locks the recipient, writes in event order (so the
  // caps keep "the first N of the day") and evaluates their badges before it commits.
  for (const awards of byUser.values()) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const outcome = await writeAwards(client, awards, { notify: false, earnedAt: "event", evaluateAlways: true });
      await client.query("commit");
      summary.awards += outcome.awards;
      summary.badges += outcome.badges;
      if (outcome.awards > 0) summary.users++;
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw new Error(`gamification backfill failed for a user: ${String(err)}`, { cause: err });
    } finally {
      client.release();
    }
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`update users set achievements_seen_at = now() where achievements_seen_at is null or achievements_seen_at < now()`);
    await client.query(
      `insert into platform_settings (key, value, updated_at) values ($1, to_jsonb(now()), now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [GAMIFICATION_BACKFILLED_AT_KEY],
    );
    await appendAudit(client, {
      actorUserId: null,
      action: "gamification.backfilled",
      targetType: "platform_settings",
      targetId: GAMIFICATION_BACKFILLED_AT_KEY,
      after: { users: summary.users, awards: summary.awards, badges: summary.badges },
    });
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return summary;
}

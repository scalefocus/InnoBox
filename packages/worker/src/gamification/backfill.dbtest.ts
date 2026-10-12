// Live-DB integration test (gated) for the §23.11 gamification backfill: existing history is
// replayed with original occurred_at (audit rows first, column fallbacks second), anonymous items'
// author awards are skipped, the daily caps apply per original day, the current assignee gets
// assignment_solved, badges are dated by the award that reached them, nothing is notified, and the
// job stamps itself, audits counts only, and is a no-op on the next run (idempotent).
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test("gamification backfill: replays history silently and once", { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" }, async () => {
  const { Pool } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  const { runGamificationBackfill } = await import("./backfill.js");

  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    // Fresh run: forget any earlier stamp (the app role may UPDATE platform_settings, not DELETE).
    await pool.query(`update platform_settings set value = 'null'::jsonb where key = 'gamification_backfilled_at'`);

    const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
    const globalId = g[0]!.id;
    const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active limit 1`);
    const mkUser = async (label: string) =>
      (
        await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`, [
          `dbtest-bf-${label}-${stamp}`,
          `dbtest-bf-${label}-${stamp}@example.test`,
          `Dbtest bf ${label}`,
        ])
      ).rows[0]!.id;
    const author = await mkUser("author");
    const solver = await mkUser("solver");
    const fan = await mkUser("fan");
    const assignee = await mkUser("assignee");

    const mkChallenge = async (authorId: string, status: string, opts: { anonymous?: boolean; assigneeId?: string; daysAgo: number }) =>
      (
        await pool.query<{ id: string }>(
          `insert into challenges (namespace_id, visibility, title, description, impact_area_id, is_anonymous, author_id, status, assignee_id, created_at, status_changed_at)
           values ($1, 'org', $2, 'd', $3, $4, $5, $6, $7, now() - make_interval(days => $8), now() - make_interval(days => $8))
           returning id`,
          [globalId, `BF ${stamp}`, ia[0]!.id, opts.anonymous ?? false, authorId, status, opts.assigneeId ?? null, opts.daysAgo],
        )
      ).rows[0]!.id;

    // A named challenge that went valid two days ago (audit row) and solved yesterday (fallback).
    const named = await mkChallenge(author, "solved", { daysAgo: 3, assigneeId: assignee });
    await pool.query(
      `insert into audit_log (actor_user_id, action, target_type, target_id, before, after, created_at)
       values (null, 'challenge.status_changed', 'challenge', $1, '{"status":"in_review"}', '{"status":"valid"}', now() - interval '2 days')`,
      [named],
    );
    await pool.query(`update challenges set resolved_at = now() - interval '1 day' where id = $1`, [named]);
    const anonymous = await mkChallenge(author, "valid", { anonymous: true, daysAgo: 3 });

    // A solution implemented (no audit row → status_changed_at fallback), liked by the fan.
    const { rows: s } = await pool.query<{ id: string }>(
      `insert into solutions (challenge_id, description, author_id, status, created_at, status_changed_at)
       values ($1, 'd', $2, 'implemented', now() - interval '2 days', now() - interval '1 day') returning id`,
      [named, solver],
    );
    const solution = s[0]!.id;
    await pool.query(`insert into likes (user_id, parent_type, parent_id, created_at) values ($1, 'challenge', $2, now() - interval '3 days')`, [fan, named]);
    await pool.query(`insert into likes (user_id, parent_type, parent_id) values ($1, 'challenge', $2)`, [fan, anonymous]);
    await pool.query(`insert into likes (user_id, parent_type, parent_id) values ($1, 'solution', $2)`, [author, solution]);

    // Seven comments by the fan on one past day (5 earn a point, 2 are 0-point rows), one deleted.
    for (let i = 0; i < 7; i++) {
      await pool.query(`insert into comments (parent_type, parent_id, author_id, body, created_at) values ('challenge', $1, $2, 'c', now() - interval '5 days' + make_interval(mins => $3))`, [
        named,
        fan,
        i,
      ]);
    }
    await pool.query(`insert into comments (parent_type, parent_id, author_id, body, deleted_at) values ('challenge', $1, $2, 'gone', now())`, [named, fan]);

    const summary = await runGamificationBackfill(pool);
    assert.equal(summary.ran, true);
    assert.ok(summary.awards > 0);

    const ledger = async (userId: string) =>
      (await pool.query<{ reason: string; points: number; occurred_at: Date; item_id: string }>(`select reason, points, occurred_at, item_id from gamification_ledger where user_id = $1 order by occurred_at, id`, [userId])).rows;

    const authorRows = await ledger(author);
    assert.deepEqual(
      authorRows.map((r) => r.reason).sort(),
      ["challenge_solved", "challenge_submitted", "challenge_validated", "like_received"],
      "the anonymous challenge (and the like on it) earns its author nothing",
    );
    assert.ok(!authorRows.some((r) => r.item_id === anonymous));
    const validated = authorRows.find((r) => r.reason === "challenge_validated")!;
    assert.ok(Math.abs(Date.now() - 2 * 86400_000 - validated.occurred_at.getTime()) < 60_000, "dated by the audit row");
    const solved = authorRows.find((r) => r.reason === "challenge_solved")!;
    assert.ok(Math.abs(Date.now() - 86400_000 - solved.occurred_at.getTime()) < 60_000, "dated by resolved_at");

    assert.deepEqual((await ledger(solver)).map((r) => r.reason).sort(), ["like_received", "solution_implemented", "solution_proposed"]);
    assert.deepEqual((await ledger(assignee)).map((r) => r.reason), ["assignment_solved"]);
    const fanComments = (await ledger(fan)).filter((r) => r.reason === "comment_posted");
    assert.deepEqual(
      fanComments.map((r) => r.points),
      [1, 1, 1, 1, 1, 0, 0],
      "caps per original day; the deleted comment is skipped",
    );

    // Badges are dated by the award that reached them; nothing was notified.
    const { rows: badges } = await pool.query<{ badge_key: string; earned_at: Date }>(`select badge_key, earned_at from user_badges where user_id = $1`, [author]);
    const icebreaker = badges.find((b) => b.badge_key === "icebreaker")!;
    assert.ok(Date.now() - icebreaker.earned_at.getTime() > 2.5 * 86400_000, "earned when the first challenge was submitted");
    const { rows: notes } = await pool.query(`select 1 from notifications where user_id = any($1::uuid[]) and type = 'achievement_earned'`, [[author, solver, fan, assignee]]);
    assert.equal(notes.length, 0, "the backfill writes no notifications");

    // Stamped, toast markers set, audited with counts only — and the next run is a no-op.
    const { rows: seen } = await pool.query<{ achievements_seen_at: Date | null }>(`select achievements_seen_at from users where id = $1`, [author]);
    assert.ok(seen[0]!.achievements_seen_at);
    const { rows: audit } = await pool.query<{ actor_user_id: string | null; after: Record<string, number> }>(
      `select actor_user_id, after from audit_log where action = 'gamification.backfilled' order by id desc limit 1`,
    );
    assert.equal(audit[0]!.actor_user_id, null);
    assert.deepEqual(Object.keys(audit[0]!.after).sort(), ["awards", "badges", "users"]);
    const again = await runGamificationBackfill(pool);
    assert.equal(again.ran, false);
  } finally {
    await pool.end();
  }
});

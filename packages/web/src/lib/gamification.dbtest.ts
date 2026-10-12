// Live-DB integration test (gated) for §23 gamification (INNOBOX_SPEC.md §23.12):
//   • awards are written in the triggering transaction for create, transition (enforced and
//     override), the §8.3 auto-close (implemented + solved + assignment together), like, comment;
//   • first entry only (valid → needs_improvement → valid awards once); a self-like writes nothing;
//   • daily caps (the 6th comment of the day is a 0-point row that still counts for badges);
//   • no award while anonymous, and the self-reveal replay with backdated occurred_at;
//   • no deduction on unlike, revert, withdraw or the §10.3 delete;
//   • badges incl. Full Circle; one event 13 inbox row per transaction, no outbox row;
//   • the switch: off suppresses event 13 and nulls every block while accrual continues;
//   • the Points ranking's org-visible test and opt-out exclusion; hidden users masked in the
//     profile, card and leaderboard chips; erasure clears the rows.
// Self-skips when DATABASE_URL is unset. It flips the platform switch and restores it to off.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "gamification: awards, caps, anonymity replay, badges, notifications, ranking and masking",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const store = await import("../app/api/challenges/store");
    const { createComment } = await import("../app/api/comments/store");
    const { removeLike } = await import("../app/api/likes/store");
    const { setGamificationEnabled } = await import("../app/api/admin/settings/store");
    const { getLeaderboard, clearLeaderboardCache } = await import("../app/api/leaderboards/store");
    const { scrubUser } = await import("../app/api/users/store");
    const read = await import("./gamification-read");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: nsRows } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, 'Dbtest Gamification NS') returning id`, [
        `dbtest-gam-${stamp}`,
      ]);
      const nsId = nsRows[0]!.id;
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`, [
          `dbtest-gam-${label}-${stamp}`,
          `dbtest-gam-${label}-${stamp}@example.test`,
          `Dbtest gam ${label} ${stamp}`,
        ]);
        return rows[0]!.id;
      };
      const member = (id: string) => ({ userId: id, roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }) });
      const author = member(await mkUser("author"));
      const other = member(await mkUser("other"));
      const assignee = member(await mkUser("assignee"));
      const committee = { userId: await mkUser("committee"), roles: buildRoleSet([{ role: "committee", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      const admin = { userId: await mkUser("admin"), roles: buildRoleSet([{ role: "platform_admin", namespaceId: null }], { globalNamespaceId: globalId }) };
      const internal = (await store.listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;

      const ledger = async (userId: string) =>
        (
          await pool.query<{ reason: string; points: number; occurred_at: Date; item_id: string }>(
            `select reason, points, occurred_at, item_id from gamification_ledger where user_id = $1 order by id`,
            [userId],
          )
        ).rows;
      const reasons = async (userId: string) => (await ledger(userId)).map((r) => r.reason);
      const badges = async (userId: string) =>
        (await pool.query<{ badge_key: string; tier: number | null }>(`select badge_key, tier from user_badges where user_id = $1 order by badge_key, tier`, [userId])).rows;
      const inbox = async (userId: string) =>
        (await pool.query<{ payload: { message: string; link: string } }>(`select payload from notifications where user_id = $1 and type = 'achievement_earned' order by created_at`, [userId]))
          .rows;
      const outbox = async (userId: string) =>
        Number((await pool.query<{ n: string }>(`select count(*)::text as n from notification_outbox where user_id = $1 and type = 'achievement_earned'`, [userId])).rows[0]!.n);

      const mkChallenge = async (viewer: typeof author, opts: { anonymous?: boolean; visibility?: "org" | "namespace" } = {}) => {
        const res = await store.createChallenge(pool, viewer, {
          impactAreaId: internal.id,
          namespaceId: nsId,
          title: `Gam ${stamp}`,
          description: "d",
          clientName: null,
          visibility: opts.visibility ?? "org",
          isAnonymous: opts.anonymous ?? false,
        });
        assert.equal(res.status, "ok");
        if (res.status !== "ok") throw new Error("create failed");
        return { id: res.challenge.id, num: res.challenge.number.replace("CH-", "") };
      };

      // ── Switch ON for the first half: event 13 rows are written. ─────────────────────────
      await setGamificationEnabled(pool, true, admin.userId);

      // Create: a named challenge awards 5, earns Icebreaker, and writes one inbox row (no outbox).
      const ch = await mkChallenge(author);
      assert.deepEqual(await reasons(author.userId), ["challenge_submitted"]);
      assert.equal((await ledger(author.userId))[0]!.points, 5);
      assert.deepEqual(await badges(author.userId), [{ badge_key: "icebreaker", tier: null }]);
      assert.equal((await inbox(author.userId)).length, 1);
      assert.equal((await inbox(author.userId))[0]!.payload.message, "You earned Icebreaker.");
      assert.equal((await inbox(author.userId))[0]!.payload.link, "/profile");
      assert.equal(await outbox(author.userId), 0, "event 13 is in-app only");

      // Transition by admin override → valid; bouncing back to valid awards nothing new.
      assert.equal((await store.setChallengeStatus(pool, admin, ch.num, "valid")).status, "ok");
      assert.equal((await store.setChallengeStatus(pool, admin, ch.num, "needs_improvement")).status, "ok");
      assert.equal((await store.setChallengeStatus(pool, admin, ch.num, "valid")).status, "ok");
      assert.deepEqual(await reasons(author.userId), ["challenge_submitted", "challenge_validated"], "first entry only");
      assert.ok((await badges(author.userId)).some((b) => b.badge_key === "problem_spotter" && b.tier === 1));

      // Likes: by someone else awards 1; a self-like writes nothing; unlike deducts nothing; re-like reuses the key.
      assert.equal((await store.toggleLike(pool, other, "challenge", ch.id)).status, "ok");
      assert.equal((await store.toggleLike(pool, author, "challenge", ch.id)).status, "ok");
      assert.equal((await removeLike(pool, other, "challenge", ch.id)).status, "ok");
      assert.equal((await store.toggleLike(pool, other, "challenge", ch.id)).status, "ok");
      assert.equal((await reasons(author.userId)).filter((r) => r === "like_received").length, 1);

      // Comments: the commenter earns 1 for each of the first 5 of the day, 0 after.
      for (let i = 0; i < 6; i++) assert.equal((await createComment(pool, other, "challenge", ch.id, `c${i}`)).status, "ok");
      const commentRows = (await ledger(other.userId)).filter((r) => r.reason === "comment_posted");
      assert.equal(commentRows.length, 6, "the capped comment still gets a row");
      assert.deepEqual(
        commentRows.map((r) => r.points),
        [1, 1, 1, 1, 1, 0],
      );

      // Solution + enforced transition by committee, then the §8.3 auto-close by admin override.
      await pool.query(`update challenges set assignee_id = $2 where id = $1`, [ch.id, assignee.userId]);
      const sol = await store.createSolution(pool, author, ch.num, { description: "own solution", costVsBenefits: null, isAnonymous: false });
      assert.equal(sol.status, "ok");
      if (sol.status !== "ok") return;
      const solNum = sol.solution.number.replace("SOL-", "");
      assert.equal((await store.setSolutionStatus(pool, committee, solNum, "in_review")).status, "ok");
      assert.equal((await store.setSolutionStatus(pool, committee, solNum, "valid")).status, "ok", "an enforced move awards too");
      const inboxBefore = (await inbox(author.userId)).length;
      assert.equal((await store.setSolutionStatus(pool, admin, solNum, "implemented")).status, "ok");
      const authorReasons = await reasons(author.userId);
      for (const r of ["solution_proposed", "solution_validated", "solution_implemented", "challenge_solved"]) assert.ok(authorReasons.includes(r), r);
      assert.deepEqual(await reasons(assignee.userId), ["assignment_solved"], "the assignee at the solve");
      assert.ok((await badges(author.userId)).some((b) => b.badge_key === "full_circle"), "own solution on own challenge");
      assert.equal((await inbox(author.userId)).length, inboxBefore + 1, "the auto-close's awards are one transaction, one row");
      assert.match((await inbox(author.userId)).at(-1)!.payload.message, /Full Circle/);

      // Revert out of solved and re-solve: nothing new; withdrawing deducts nothing.
      const pointsBefore = (await read.pointsTotals(pool, [author.userId])).get(author.userId)!;
      assert.equal((await store.setChallengeStatus(pool, admin, ch.num, "valid")).status, "ok");
      assert.equal((await store.setChallengeStatus(pool, admin, ch.num, "solved")).status, "ok");
      const ch2 = await mkChallenge(author);
      assert.equal((await store.withdrawChallenge(pool, author, ch2.num)).status, "ok");
      const pointsAfter = (await read.pointsTotals(pool, [author.userId])).get(author.userId)!;
      assert.equal(pointsAfter, pointsBefore + 5, "only the new submission; nothing deducted or re-awarded");

      // ── Anonymity: nothing while anonymous, a backdated replay on self-reveal. ────────────
      const anonAuthor = member(await mkUser("anon"));
      const anon = await mkChallenge(anonAuthor, { anonymous: true });
      assert.equal((await store.setChallengeStatus(pool, admin, anon.num, "valid")).status, "ok");
      assert.equal((await store.toggleLike(pool, other, "challenge", anon.id)).status, "ok");
      assert.equal((await createComment(pool, anonAuthor, "challenge", anon.id, "my own comment")).status, "ok");
      assert.deepEqual(await reasons(anonAuthor.userId), ["comment_posted"], "comments are never anonymous");
      await pool.query(`update challenges set created_at = now() - interval '10 days' where id = $1`, [anon.id]);
      assert.equal((await store.selfRevealChallenge(pool, anonAuthor, anon.num)).status, "ok");
      const replayed = await ledger(anonAuthor.userId);
      assert.deepEqual(replayed.map((r) => r.reason).sort(), ["challenge_submitted", "challenge_validated", "comment_posted", "like_received"]);
      const submitted = replayed.find((r) => r.reason === "challenge_submitted")!;
      assert.ok(Date.now() - submitted.occurred_at.getTime() > 9 * 24 * 3600 * 1000, "occurred_at is the original event time");
      assert.ok((await inbox(anonAuthor.userId)).length >= 1, "badges reached by the replay notify normally");

      // ── Points ranking: org-visible items only, opt-outs excluded; totals unaffected. ─────
      const restrictedAuthor = member(await mkUser("restricted"));
      const restricted = await mkChallenge(restrictedAuthor, { visibility: "namespace" });
      assert.equal((await store.setChallengeStatus(pool, admin, restricted.num, "valid")).status, "ok");
      assert.equal((await read.pointsTotals(pool, [restrictedAuthor.userId])).get(restrictedAuthor.userId), 25, "restricted work counts toward the total");
      const board = await getLeaderboard(pool, "points", "all", 100_000);
      assert.ok(!board.some((e) => e.userId === restrictedAuthor.userId), "but not toward the ranking");
      assert.ok(board.some((e) => e.userId === author.userId));
      await pool.query(`update users set gamification_public = false where id = $1`, [author.userId]);
      assert.ok(!(await getLeaderboard(pool, "points", "all", 100_000)).some((e) => e.userId === author.userId), "hidden users drop out of Points");
      assert.ok((await getLeaderboard(pool, "challenges_submitted", "all", 100_000)).some((e) => e.userId === author.userId), "the other metrics are unchanged");

      // Masking: hidden from others in the profile, card and leaderboard chips; the owner sees all.
      clearLeaderboardCache();
      assert.equal(await read.publicGamification(pool, author.userId), null);
      assert.equal(await read.cardGamification(pool, author.userId), null);
      assert.equal((await read.levelChips(pool, [author.userId])).get(author.userId), null);
      const own = (await read.ownGamification(pool, author.userId))!;
      assert.ok(own.points > 0 && own.earned.length > 0 && own.locked.length > 0);
      await pool.query(`update users set gamification_public = true where id = $1`, [author.userId]);
      const card = (await read.cardGamification(pool, author.userId))!;
      assert.ok(card.recentBadges.length <= 3 && card.recentBadges.length > 0);
      assert.ok(!JSON.stringify(card).includes(ch.id), "no block names an item");

      // ── Switch OFF: accrual continues, event 13 and every block are suppressed. ───────────
      await setGamificationEnabled(pool, false, admin.userId);
      const quiet = member(await mkUser("quiet"));
      await mkChallenge(quiet);
      assert.deepEqual(await reasons(quiet.userId), ["challenge_submitted"], "accrual is independent of the switch");
      assert.ok((await badges(quiet.userId)).length === 1);
      assert.equal((await inbox(quiet.userId)).length, 0, "no event 13 while off");
      assert.equal(await read.meGamification(pool, quiet.userId), null);
      assert.equal(await read.ownGamification(pool, quiet.userId), null);
      assert.deepEqual(await read.newAchievements(pool, quiet.userId), []);

      // Turning it on later never floods: only things earned after the flip are new.
      await setGamificationEnabled(pool, true, admin.userId);
      assert.deepEqual(await read.newAchievements(pool, quiet.userId), [], "earned before enabling");
      for (let i = 0; i < 4; i++) await mkChallenge(quiet);
      const fresh = await read.newAchievements(pool, quiet.userId);
      assert.deepEqual(fresh, [{ kind: "level", level: 2 }], "25 points crossed after enabling");
      await read.markAchievementsSeen(pool, quiet.userId);
      assert.deepEqual(await read.newAchievements(pool, quiet.userId), []);
      await pool.query(`update users set notify_achievements = false where id = $1`, [quiet.userId]);
      const quietInbox = (await inbox(quiet.userId)).length;
      for (let i = 0; i < 10; i++) await mkChallenge(quiet);
      assert.equal((await inbox(quiet.userId)).length, quietInbox, "the Achievements preference gates event 13");

      // ── Erasure clears the ledger and badges, and resets the columns. ─────────────────────
      assert.equal((await scrubUser(pool, admin.userId, quiet.userId)).status, "ok");
      assert.equal((await ledger(quiet.userId)).length, 0);
      assert.equal((await badges(quiet.userId)).length, 0);
      const { rows: reset } = await pool.query<{ gamification_public: boolean; notify_achievements: boolean; achievements_seen_at: Date | null }>(
        `select gamification_public, notify_achievements, achievements_seen_at from users where id = $1`,
        [quiet.userId],
      );
      assert.deepEqual(reset[0], { gamification_public: true, notify_achievements: true, achievements_seen_at: null });

      // Append-only: the app role cannot UPDATE the ledger.
      await assert.rejects(pool.query(`update gamification_ledger set points = 99 where user_id = $1`, [author.userId]), /permission denied/);
    } finally {
      const { setGamificationEnabled } = await import("../app/api/admin/settings/store");
      const { rows } = await pool.query<{ id: string }>(`select id from users limit 1`);
      if (rows[0]) await setGamificationEnabled(pool, false, rows[0].id).catch(() => {});
      await pool.end();
    }
  },
);

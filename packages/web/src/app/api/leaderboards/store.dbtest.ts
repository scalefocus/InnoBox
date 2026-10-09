// Live-DB integration test (gated) for the leaderboard (INNOBOX_SPEC.md §13.3): counts cover only
// org-visible (§4.3, applied to the item AND a solution's parent challenge), non-anonymous,
// non-rejected contributions; "solutions implemented" is dated by when the solution entered
// `implemented` (status_changed_at), not its last edit; and every entry carries the user's
// `active` flag for the §13.6 greyed bubble. The suite shares its database with the other dbtests,
// so it reads the full ranking (a large limit) and asserts on its own fixture users only.
// Self-skips when DATABASE_URL is unset; like the other suites it leaves its rows behind.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "getLeaderboard: only org-visible, non-anonymous, non-rejected contributions count",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { listActiveImpactAreas } = await import("../challenges/store");
    const { getLeaderboard } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: nsRows } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, 'Dbtest Leaderboard NS') returning id`,
        [`dbtest-lb-${stamp}`],
      );
      const nsId = nsRows[0]!.id;
      const area = (await listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;

      const mkUser = async (label: string, active = true) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name, active) values ($1, $2, $3, $4) returning id`,
          [`dbtest-lb-${label}-${stamp}`, `dbtest-lb-${label}-${stamp}@example.test`, `Dbtest LB ${label} ${stamp}`, active],
        );
        return rows[0]!.id;
      };
      const star = await mkUser("star");
      const solver = await mkUser("solver");
      const gone = await mkUser("gone", false);
      const likers = [await mkUser("liker1"), await mkUser("liker2")];

      const mkChallenge = async (
        authorId: string,
        status: string,
        opts: { visibility?: "org" | "namespace"; anonymous?: boolean } = {},
      ): Promise<string> => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into challenges (namespace_id, visibility, title, description, impact_area_id, is_anonymous, author_id, status)
           values ($1, $2, $3, 'd', $4, $5, $6, $7) returning id`,
          [opts.visibility === "namespace" ? nsId : globalId, opts.visibility ?? "org", `LB ${stamp}`, area.id, opts.anonymous ?? false, authorId, status],
        );
        return rows[0]!.id;
      };
      const mkSolution = async (challengeId: string, authorId: string, status: string, opts: { anonymous?: boolean } = {}): Promise<string> => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into solutions (challenge_id, description, is_anonymous, author_id, status) values ($1, 'd', $2, $3, $4) returning id`,
          [challengeId, opts.anonymous ?? false, authorId, status],
        );
        return rows[0]!.id;
      };
      const like = async (userId: string, parentType: "challenge" | "solution", parentId: string) =>
        pool.query(`insert into likes (user_id, parent_type, parent_id) values ($1, $2, $3)`, [userId, parentType, parentId]);

      // ── challenges by `star` ───────────────────────────────────────────────────────────
      const visible = await mkChallenge(star, "valid"); // counts
      const untriaged = await mkChallenge(star, "awaiting_triage"); // not org-visible yet
      const restricted = await mkChallenge(star, "valid", { visibility: "namespace" }); // namespace-only
      await mkChallenge(star, "rejected"); // rejected
      await mkChallenge(star, "withdrawn"); // withdrawn (hidden, §4.3)
      await mkChallenge(star, "valid", { anonymous: true }); // anonymous
      await mkChallenge(gone, "valid"); // a deactivated user's visible challenge

      // ── solutions by `solver` ──────────────────────────────────────────────────────────
      const proposed = await mkSolution(visible, solver, "proposed"); // un-reviewed: hidden
      const reviewed = await mkSolution(visible, solver, "in_review"); // counts
      const implemented = await mkSolution(visible, solver, "implemented"); // counts
      await mkSolution(visible, solver, "rejected"); // rejected
      await mkSolution(visible, solver, "in_review", { anonymous: true }); // anonymous
      await mkSolution(restricted, solver, "in_review"); // parent is namespace-only
      await mkSolution(untriaged, solver, "in_review"); // parent not triaged
      const laterWithdrawn = await mkChallenge(star, "valid");
      const orphaned = await mkSolution(laterWithdrawn, solver, "in_review");
      await pool.query(`update challenges set status = 'withdrawn' where id = $1`, [laterWithdrawn]); // parent withdrawn

      // The implementation happened 40 days ago; the row was merely touched today.
      await pool.query(
        `update solutions set status_changed_at = now() - interval '40 days', updated_at = now() where id = $1`,
        [implemented],
      );

      // ── likes ──────────────────────────────────────────────────────────────────────────
      await like(likers[0]!, "challenge", visible); // counts (star)
      await like(likers[1]!, "challenge", visible); // counts (star)
      await like(likers[0]!, "challenge", untriaged); // hidden parent
      await like(likers[0]!, "challenge", restricted); // namespace-only
      await like(likers[0]!, "solution", proposed); // un-reviewed solution
      await like(likers[0]!, "solution", reviewed); // counts (solver)
      await like(likers[0]!, "solution", orphaned); // parent withdrawn

      const countFor = async (metric: Parameters<typeof getLeaderboard>[1], window: "30d" | "all", userId: string) => {
        const entries = await getLeaderboard(pool, metric, window, 100_000);
        return entries.find((e) => e.userId === userId)?.count ?? 0;
      };

      assert.equal(await countFor("challenges_submitted", "all", star), 1, "only the org-visible, triaged, non-rejected, named challenge");
      assert.equal(await countFor("solutions_proposed", "all", solver), 2, "reviewed + implemented; not proposed/rejected/anonymous/hidden-parent");
      assert.equal(await countFor("solutions_implemented", "all", solver), 1);
      assert.equal(
        await countFor("solutions_implemented", "30d", solver),
        0,
        "dated by when it entered `implemented`, not by its last edit",
      );
      assert.equal(await countFor("likes_received", "all", star), 2, "likes on hidden/restricted challenges never count");
      assert.equal(await countFor("likes_received", "all", solver), 1, "likes on a proposed solution or one under a withdrawn challenge never count");

      // §13.6: a deactivated contributor is still ranked, flagged for the greyed bubble.
      const all = await getLeaderboard(pool, "challenges_submitted", "all", 100_000);
      assert.equal(all.find((e) => e.userId === gone)?.active, false);
      assert.equal(all.find((e) => e.userId === star)?.active, true);

      // The route's default is the §13.3 top 10.
      assert.ok((await getLeaderboard(pool, "challenges_submitted", "all")).length <= 10);
    } finally {
      await pool.end();
    }
  },
);

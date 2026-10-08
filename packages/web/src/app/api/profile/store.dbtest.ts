// Live-DB integration test (gated) for another user's public profile (INNOBOX_SPEC.md §13.5).
// "Org-visible" is the full §4.3 test applied to the item AND, for a solution, its parent
// challenge — so a solution whose challenge is withdrawn or back in awaiting_triage drops off
// the public profile, and reappears when the challenge is visible again. Self-skips when
// DATABASE_URL is unset; like the other suites it leaves its rows behind (never hard-deleted).
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "getPublicProfile: a solution is listed only while its parent challenge is publicly visible",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { buildRoleSet } = await import("@innobox/shared");
    const { createChallenge, createSolution, listActiveImpactAreas, setChallengeStatus, setSolutionStatus } = await import(
      "../challenges/store"
    );
    const { getPublicProfile } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: nsRows } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, 'Dbtest Profile NS') returning id`,
        [`dbtest-profile-${stamp}`],
      );
      const nsId = nsRows[0]!.id;
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name, active) values ($1, $2, $3, true) returning id`,
          [`dbtest-profile-${label}-${stamp}`, `dbtest-profile-${label}-${stamp}@example.test`, `Dbtest Profile ${label}`],
        );
        return rows[0]!.id;
      };
      const roles = (grants: { role: "namespace_admin" | "member"; namespaceId: string }[]) =>
        buildRoleSet(grants, { globalNamespaceId: globalId });
      const author = { userId: await mkUser("author"), roles: roles([{ role: "member", namespaceId: nsId }]) };
      const solver = { userId: await mkUser("solver"), roles: roles([{ role: "member", namespaceId: nsId }]) };
      const admin = { userId: await mkUser("admin"), roles: roles([{ role: "namespace_admin", namespaceId: nsId }]) };
      const internal = (await listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;

      // An org-visible challenge, made valid, with a non-anonymous solution moved past `proposed`.
      const ch = await createChallenge(pool, author, {
        impactAreaId: internal.id,
        namespaceId: nsId,
        title: `Profile parent ${stamp}`,
        description: "d",
        clientName: null,
        visibility: "org",
        isAnonymous: false,
      });
      assert.equal(ch.status, "ok");
      if (ch.status !== "ok") return;
      const chNum = ch.challenge.number.replace("CH-", "");
      const chId = ch.challenge.id;
      assert.equal((await setChallengeStatus(pool, admin, chNum, "valid")).status, "ok");
      const sol = await createSolution(pool, solver, chNum, { description: `Profile solution ${stamp}`, costVsBenefits: null, isAnonymous: false });
      assert.equal(sol.status, "ok");
      if (sol.status !== "ok") return;
      const solNumber = sol.solution.number;
      assert.equal((await setSolutionStatus(pool, admin, solNumber.replace("SOL-", ""), "in_review")).status, "ok");

      const listed = async () =>
        (await getPublicProfile(pool, solver.userId))!.contributions.solutions.map((s) => s.number);

      // Visible parent → the solution is on the solver's public profile.
      assert.deepEqual(await listed(), [solNumber]);

      // Parent withdrawn → hidden. (Set directly: the store query, not the transition, is under test.)
      await pool.query(`update challenges set status = 'withdrawn' where id = $1`, [chId]);
      assert.deepEqual(await listed(), [], "a solution on a withdrawn challenge is not listed");

      // Parent back in awaiting_triage → still hidden.
      await pool.query(`update challenges set status = 'awaiting_triage' where id = $1`, [chId]);
      assert.deepEqual(await listed(), [], "a solution on an awaiting_triage challenge is not listed");

      // Parent visible again → the solution reappears.
      await pool.query(`update challenges set status = 'valid' where id = $1`, [chId]);
      assert.deepEqual(await listed(), [solNumber], "the solution reappears once the challenge is visible");
    } finally {
      await pool.end();
    }
  },
);

async function importDeps() {
  const { Pool } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  return { Pool, randomUUID };
}

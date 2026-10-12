// Live-DB integration test (gated) for another user's public profile (INNOBOX_SPEC.md §13.5).
// "Org-visible" is the full §4.3 test applied to the item AND, for a solution, its parent
// challenge — so a solution whose challenge is withdrawn or back in awaiting_triage drops off
// the public profile, and reappears when the challenge is visible again. Self-skips when
// DATABASE_URL is unset; like the other suites it leaves its rows behind (never hard-deleted).
// The owner's own "items I follow" lists apply the full §4.3 predicate too: a follow outlives the
// owner's access, and the list must not keep showing titles and statuses they can no longer see.
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

test(
  "getPublicProfile: a deactivated user's profile renders (active=false); a scrubbed or unknown id is null",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { getPublicProfile } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const mkUser = async (label: string, active: boolean, scrubbed: boolean) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name, job_title, active, scrubbed_at)
           values ($1, $2, $3, 'Engineer', $4, case when $5::boolean then now() end) returning id`,
          [`dbtest-profile-${label}-${stamp}`, `dbtest-profile-${label}-${stamp}@example.test`, `Dbtest Profile ${label}`, active, scrubbed],
        );
        return rows[0]!.id;
      };

      // §13.5: a deactivated user still has a profile — the "View profile" link always lands.
      const deactivated = await getPublicProfile(pool, await mkUser("deactivated", false, false));
      assert.ok(deactivated, "a deactivated user's profile renders");
      assert.equal(deactivated.user.active, false);
      assert.equal(deactivated.user.scrubbed, false);
      assert.equal(deactivated.user.jobTitle, "Engineer", "directory fields are retained");

      const live = await getPublicProfile(pool, await mkUser("live", true, false));
      assert.equal(live?.user.active, true);

      // A scrubbed user has no profile — the same not-found as an unknown id.
      assert.equal(await getPublicProfile(pool, await mkUser("scrubbed", false, true)), null);
      assert.equal(await getPublicProfile(pool, randomUUID()), null);
    } finally {
      await pool.end();
    }
  },
);

test(
  "getOwnProfile: the followed-items lists show only what the owner can currently see",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { buildRoleSet } = await import("@innobox/shared");
    const { getOwnProfile } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: nsRows } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, 'Dbtest Follow NS') returning id`,
        [`dbtest-follow-${stamp}`],
      );
      const nsId = nsRows[0]!.id;
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-follow-${label}-${stamp}`, `dbtest-follow-${label}-${stamp}@example.test`, `Dbtest Follow ${label}`],
        );
        return rows[0]!.id;
      };
      const ownerId = await mkUser("owner");
      const otherId = await mkUser("other");
      // The owner holds no grant in the namespace (e.g. lost membership after following).
      const owner = { userId: ownerId, roles: buildRoleSet([], { globalNamespaceId: globalId }) };

      const mkChallenge = async (label: string, namespaceId: string, visibility: "org" | "namespace", status: string) => {
        const { rows } = await pool.query<{ id: string; number: string }>(
          `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
           values ($1, $2, $3, 'follow fixture', $4, $5, $6) returning id, number::text`,
          [namespaceId, visibility, `Follow ${label} ${stamp}`, ia[0]!.id, otherId, status],
        );
        return { id: rows[0]!.id, number: `CH-${rows[0]!.number}` };
      };
      const mkSolution = async (challengeId: string, status: string) => {
        const { rows } = await pool.query<{ id: string; number: string }>(
          `insert into solutions (challenge_id, description, author_id, status) values ($1, $2, $3, $4) returning id, number::text`,
          [challengeId, `Follow solution ${status} ${stamp}`, otherId, status],
        );
        return { id: rows[0]!.id, number: `SOL-${rows[0]!.number}` };
      };
      const follow = (parentType: "challenge" | "solution", parentId: string) =>
        pool.query(`insert into follows (user_id, parent_type, parent_id) values ($1, $2, $3)`, [ownerId, parentType, parentId]);

      const openCh = await mkChallenge("open", globalId, "org", "valid");
      const restrictedCh = await mkChallenge("restricted", nsId, "namespace", "valid");
      const withdrawnCh = await mkChallenge("withdrawn", globalId, "org", "withdrawn");
      for (const c of [openCh, restrictedCh, withdrawnCh]) await follow("challenge", c.id);

      const visibleSol = await mkSolution(openCh.id, "in_review");
      const proposedSol = await mkSolution(openCh.id, "proposed"); // someone else's, not yet reviewed
      const underRestricted = await mkSolution(restrictedCh.id, "in_review");
      const underWithdrawn = await mkSolution(withdrawnCh.id, "in_review");
      for (const s of [visibleSol, proposedSol, underRestricted, underWithdrawn]) await follow("solution", s.id);

      const profile = await getOwnProfile(pool, owner);
      assert.ok(profile);
      // The owner follows nothing else, so the lists are exactly the visible fixtures.
      assert.deepEqual(
        profile!.following.challenges.map((c) => c.number),
        [openCh.number],
        "only the visible followed challenge is listed",
      );
      assert.deepEqual(
        profile!.following.solutions.map((s) => s.number),
        [visibleSol.number],
        "only the visible followed solution is listed",
      );
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

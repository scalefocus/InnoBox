// Live-DB integration test (gated) for the Home dashboard (INNOBOX_SPEC.md §13.2, §4.3,
// invariant 2): the solution KPIs and both spotlights apply the FULL per-viewer predicate — a
// solution under a withdrawn or re-triaged (awaiting_triage) challenge neither counts nor becomes
// a spotlight (which would show that challenge's title) for a viewer who cannot see the parent,
// while its author still gets both. Counts are global, so the test measures deltas against a
// baseline taken before its fixtures exist (the dbtest suites run one at a time). Self-skips when
// DATABASE_URL is unset; like the other suites it leaves its rows behind.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "dashboard: a solution under a challenge the viewer cannot see is neither counted nor spotlighted",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const { getDashboard } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-dash-${label}-${stamp}`, `dbtest-dash-${label}-${stamp}@example.test`, `Dbtest Dash ${label}`],
        );
        return rows[0]!.id;
      };
      const viewerOf = (userId: string) => ({ userId, roles: buildRoleSet([], { globalNamespaceId: globalId }) });
      const author = viewerOf(await mkUser("author"));
      const outsider = viewerOf(await mkUser("outsider"));

      const before = { author: await getDashboard(pool, author), outsider: await getDashboard(pool, outsider) };

      // Org-visible challenges in global that only their author (and admins) can see by status.
      const mkChallenge = async (status: "withdrawn" | "awaiting_triage") => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
           values ($1, 'org', $2, 'dash fixture', $3, $4, $5) returning id`,
          [globalId, `Dash ${status} ${stamp}`, ia[0]!.id, author.userId, status],
        );
        return rows[0]!.id;
      };
      // A future updated_at makes each the newest of its status, so it WOULD be the spotlight.
      const mkSolution = async (challengeId: string, status: "implemented" | "in_implementation") => {
        const { rows } = await pool.query<{ number: string }>(
          `insert into solutions (challenge_id, description, author_id, status, updated_at)
           values ($1, $2, $3, $4, now() + interval '1 hour') returning number::text`,
          [challengeId, `Dash ${status} ${stamp}`, author.userId, status],
        );
        return `SOL-${rows[0]!.number}`;
      };
      const implemented = await mkSolution(await mkChallenge("withdrawn"), "implemented");
      const inImplementation = await mkSolution(await mkChallenge("awaiting_triage"), "in_implementation");

      const after = { author: await getDashboard(pool, author), outsider: await getDashboard(pool, outsider) };

      // The outsider: nothing new counted, and neither fixture is a spotlight.
      assert.equal(after.outsider.kpis.solutions.implemented, before.outsider.kpis.solutions.implemented);
      assert.equal(after.outsider.kpis.solutions.in_implementation, before.outsider.kpis.solutions.in_implementation);
      assert.notEqual(after.outsider.spotlights.lastImplemented?.number, implemented);
      assert.notEqual(after.outsider.spotlights.lastInImplementation?.number, inImplementation);
      assert.deepEqual(after.outsider.kpis.challenges, before.outsider.kpis.challenges);

      // The author can see both parents, so both count and both are spotlights.
      assert.equal(after.author.kpis.solutions.implemented, before.author.kpis.solutions.implemented! + 1);
      assert.equal(after.author.kpis.solutions.in_implementation, before.author.kpis.solutions.in_implementation! + 1);
      assert.equal(after.author.spotlights.lastImplemented?.number, implemented);
      assert.equal(after.author.spotlights.lastInImplementation?.number, inImplementation);
    } finally {
      await pool.end();
    }
  },
);

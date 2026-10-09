// Live-DB integration test (gated) for search (INNOBOX_SPEC.md §13.4): §13.1's gallery filters
// (status / impact area / namespace / author) narrow the results alongside the query, while
// visibility filtering (invariant 2) and anonymity (invariant 3) still hold — in particular the
// author filter never matches an anonymous item by its true author. Also checks the §13.6
// `active` flag on author payloads (absent for anonymous authors). Self-skips when DATABASE_URL is
// unset; like the other suites it leaves its rows behind (never hard-deleted).
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "search: gallery filters narrow results without weakening visibility or anonymity",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const { listActiveImpactAreas } = await import("../challenges/store");
    const { search } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().replace(/-/g, "").slice(0, 10);
      const token = `zq${stamp}`; // one unique search term shared by every fixture
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: nsRows } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, 'Dbtest Search NS') returning id`,
        [`dbtest-search-${stamp}`],
      );
      const nsId = nsRows[0]!.id;
      const areas = await listActiveImpactAreas(pool);
      const area1 = areas.find((a) => a.name === "Internal")!;
      const area2 = areas.find((a) => a.id !== area1.id && a.name !== "Client")!;

      const mkUser = async (label: string, active = true) => {
        const name = `Dbtest Search ${label} ${stamp}`;
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name, active) values ($1, $2, $3, $4) returning id`,
          [`dbtest-search-${label}-${stamp}`, `dbtest-search-${label}-${stamp}@example.test`, name, active],
        );
        return { id: rows[0]!.id, name };
      };
      const alice = await mkUser("Alice");
      const bob = await mkUser("Bob");
      const gone = await mkUser("Gone", false);
      const outsiderUser = await mkUser("Outsider");
      const memberUser = await mkUser("Member");
      const outsider = { userId: outsiderUser.id, roles: buildRoleSet([], { globalNamespaceId: globalId }) };
      const member = {
        userId: memberUser.id,
        roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }),
      };

      const mkChallenge = async (
        label: string,
        authorId: string,
        opts: { status?: string; areaId?: string; visibility?: "org" | "namespace"; anonymous?: boolean } = {},
      ) => {
        const { rows } = await pool.query<{ id: string; number: string }>(
          `insert into challenges (namespace_id, visibility, title, description, impact_area_id, is_anonymous, author_id, status)
           values ($1, $2, $3, 'search fixture', $4, $5, $6, $7) returning id, number::text`,
          [
            opts.visibility === "namespace" ? nsId : globalId,
            opts.visibility ?? "org",
            `${label} ${token}`,
            opts.areaId ?? area1.id,
            opts.anonymous ?? false,
            authorId,
            opts.status ?? "valid",
          ],
        );
        return { id: rows[0]!.id, number: `CH-${rows[0]!.number}` };
      };
      const mkSolution = async (challengeId: string, authorId: string, opts: { anonymous?: boolean } = {}) => {
        const { rows } = await pool.query<{ number: string }>(
          `insert into solutions (challenge_id, description, is_anonymous, author_id, status)
           values ($1, $2, $3, $4, 'in_review') returning number::text`,
          [challengeId, `solution ${token}`, opts.anonymous ?? false, authorId],
        );
        return `SOL-${rows[0]!.number}`;
      };

      const c1 = await mkChallenge("Alice valid", alice.id);
      const c2 = await mkChallenge("Bob in review", bob.id, { status: "in_review", areaId: area2.id });
      const c3 = await mkChallenge("Alice anonymous", alice.id, { anonymous: true });
      const c4 = await mkChallenge("Alice restricted", alice.id, { visibility: "namespace" });
      const c5 = await mkChallenge("Deactivated author", gone.id);
      const s1 = await mkSolution(c1.id, bob.id); // parent valid, area1
      const s2 = await mkSolution(c2.id, alice.id, { anonymous: true }); // parent in_review, area2

      const run = async (viewer: typeof outsider, q: string, filters = {}) => {
        const r = await search(pool, viewer, q, filters);
        return { challenges: r.challenges.map((c) => c.number).sort(), solutions: r.solutions.map((s) => s.number).sort(), raw: r };
      };
      const sorted = (...xs: string[]) => [...xs].sort();

      // No filters: everything visible to an outsider — never the namespace-only challenge.
      const all = await run(outsider, token);
      assert.deepEqual(all.challenges, sorted(c1.number, c2.number, c3.number, c5.number));
      assert.deepEqual(all.solutions, sorted(s1, s2));

      // Status narrows challenges, and solutions by their parent challenge's status.
      const valid = await run(outsider, token, { status: "valid" });
      assert.deepEqual(valid.challenges, sorted(c1.number, c3.number, c5.number));
      assert.deepEqual(valid.solutions, [s1]);

      // Impact area.
      const byArea = await run(outsider, token, { impactAreaId: area2.id });
      assert.deepEqual(byArea.challenges, [c2.number]);
      assert.deepEqual(byArea.solutions, [s2]);

      // Namespace: a member finds the restricted challenge; a filter never widens visibility.
      assert.deepEqual((await run(member, token, { namespaceId: nsId })).challenges, [c4.number]);
      assert.deepEqual((await run(outsider, token, { namespaceId: nsId })).challenges, []);

      // Author: never matches an anonymous item by its true author (c3, s2 are Alice's, anonymous).
      const byAlice = await run(outsider, token, { authorName: alice.name });
      assert.deepEqual(byAlice.challenges, [c1.number], "anonymous c3 must not match Alice's name");
      assert.deepEqual(byAlice.solutions, [], "anonymous s2 must not match Alice's name");
      const byBob = await run(outsider, token, { authorName: bob.name });
      assert.deepEqual(byBob.challenges, [c2.number]);
      assert.deepEqual(byBob.solutions, [s1], "the author filter applies to the solution's own author");

      // Exact number lookups honor the filters and visibility too.
      assert.deepEqual((await run(outsider, c1.number, { status: "valid" })).challenges, [c1.number]);
      assert.deepEqual((await run(outsider, c1.number, { status: "in_review" })).challenges, []);
      assert.deepEqual((await run(outsider, c4.number)).challenges, [], "an invisible challenge is not found by number");
      assert.deepEqual((await run(outsider, s1, { impactAreaId: area2.id })).solutions, []);
      assert.deepEqual((await run(outsider, s1)).solutions, [s1]);

      // §13.6 `active`: false for a deactivated author, true otherwise, ABSENT for anonymous.
      const byNumber = new Map(all.raw.challenges.map((c) => [c.number, c.author]));
      assert.equal(byNumber.get(c5.number)?.active, false);
      assert.equal(byNumber.get(c1.number)?.active, true);
      const anon = byNumber.get(c3.number)!;
      assert.deepEqual(anon, { userId: null, displayName: "Anonymous", anonymous: true });
    } finally {
      await pool.end();
    }
  },
);

// Live-DB integration test (gated) for the §4.1 archive block on new submissions:
//   • a challenge into an archived namespace is refused as `namespace_archived` (the route's 409),
//     distinct from an id that matches no namespace at all (`unknown_namespace`, the route's 400);
//   • a solution on a `valid` challenge of an archived namespace is refused as `namespace_archived`;
//   • a challenge the proposer cannot see still answers `not_found` first (invariant 2);
//   • unarchiving lifts both blocks.
// Self-skips when DATABASE_URL is unset. Mirrors challenges/likes-frozen.dbtest.ts.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "namespaces: §4.1 an archived namespace takes no new challenge and no new solution",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const { createChallenge, createSolution, listActiveImpactAreas, setChallengeStatus } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: nsRows } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, 'Dbtest Archived NS') returning id`,
        [`dbtest-archived-${stamp}`],
      );
      const nsId = nsRows[0]!.id;

      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-archived-${label}-${stamp}`, `dbtest-archived-${label}-${stamp}@example.test`, `Dbtest archived ${label}`],
        );
        return rows[0]!.id;
      };
      const author = { userId: await mkUser("author"), roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      const outsider = { userId: await mkUser("outsider"), roles: buildRoleSet([], { globalNamespaceId: globalId }) };
      const admin = {
        userId: await mkUser("admin"),
        roles: buildRoleSet([{ role: "namespace_admin", namespaceId: nsId }], { globalNamespaceId: globalId }),
      };

      const internal = (await listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;
      const submit = (namespaceId: string, visibility: "org" | "namespace") =>
        createChallenge(pool, author, {
          impactAreaId: internal.id,
          namespaceId,
          title: `Archive block ${stamp}`,
          description: "d",
          clientName: null,
          visibility,
          isAnonymous: false,
        });

      // Two valid challenges while the namespace is live: one org-visible, one restricted.
      const open = await submit(nsId, "org");
      const restricted = await submit(nsId, "namespace");
      assert.equal(open.status, "ok");
      assert.equal(restricted.status, "ok");
      if (open.status !== "ok" || restricted.status !== "ok") return;
      const openNum = open.challenge.number.replace("CH-", "");
      const restrictedNum = restricted.challenge.number.replace("CH-", "");
      assert.equal((await setChallengeStatus(pool, admin, openNum, "valid")).status, "ok");
      assert.equal((await setChallengeStatus(pool, admin, restrictedNum, "valid")).status, "ok");

      await pool.query(`update namespaces set archived_at = now() where id = $1`, [nsId]);

      // ── New challenges: archived ≠ unknown. ────────────────────────────────────────────────
      assert.deepEqual(await submit(nsId, "org"), { status: "namespace_archived" });
      assert.deepEqual(await submit(randomUUID(), "org"), { status: "unknown_namespace" }, "an id matching no namespace stays unknown");

      // ── New solutions: refused on any challenge of the archived namespace. ─────────────────
      const propose = (viewer: typeof author, number: string) => createSolution(pool, viewer, number, { description: "fix", costVsBenefits: null, isAnonymous: false });
      assert.deepEqual(await propose(outsider, openNum), { status: "namespace_archived" });
      assert.deepEqual(await propose(author, restrictedNum), { status: "namespace_archived" });
      assert.deepEqual(await propose(outsider, restrictedNum), { status: "not_found" }, "a hidden challenge answers not_found before the archive check");
      const { rows: sols } = await pool.query<{ n: string }>(
        `select count(*)::text as n from solutions where challenge_id = any($1::uuid[])`,
        [[open.challenge.id, restricted.challenge.id]],
      );
      assert.equal(sols[0]!.n, "0", "a refused proposal writes nothing");

      // ── Unarchiving lifts both blocks. ─────────────────────────────────────────────────────
      await pool.query(`update namespaces set archived_at = null where id = $1`, [nsId]);
      assert.equal((await submit(nsId, "org")).status, "ok");
      assert.equal((await propose(outsider, openNum)).status, "ok");
    } finally {
      await pool.end();
    }
  },
);

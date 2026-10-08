// Live-DB integration test (gated) for the §13.1 "new since your last visit" marker: the count
// and the per-card flag are per viewer, visibility-filtered (a namespace-restricted challenge
// elsewhere never counts), reset by marking seen, and the viewer's own submissions count like
// anyone else's. Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "new-since-last-visit: count + card flag, visibility, mark seen",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const { countNewChallenges, listChallenges } = await import("./store");
    const { markChallengesSeen } = await import("../me/store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: ns } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, 'Dbtest New NS') returning id`, [`dbtest-new-${stamp}`]);
      const nsId = ns[0]!.id;
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);
      const impactAreaId = ia[0]!.id;

      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-new-${label}-${stamp}`, `dbtest-new-${label}-${stamp}@example.test`, `Dbtest ${label} ${stamp}`],
        );
        return rows[0]!.id;
      };
      const viewerId = await mkUser("viewer");
      const otherId = await mkUser("other");
      const viewer = { userId: viewerId, roles: buildRoleSet([], { globalNamespaceId: globalId }) }; // global member only
      const insider = { userId: otherId, roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }) };

      const mkChallenge = async (authorId: string, namespaceId: string, visibility: "org" | "namespace", status = "valid") => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
           values ($1, $2, $3, 'new-marker dbtest', $4, $5, $6) returning id`,
          [namespaceId, visibility, `New marker ${stamp}`, impactAreaId, authorId, status],
        );
        return rows[0]!.id;
      };

      // A fresh user row has a NULL marker → everything visible is new. Start by marking seen so
      // the suite reasons from a known instant (older fixtures from other suites stop counting).
      await markChallengesSeen(pool, viewerId);
      await markChallengesSeen(pool, otherId);
      assert.equal(await countNewChallenges(pool, viewer), 0);
      assert.equal(await countNewChallenges(pool, insider), 0);

      const visible = await mkChallenge(otherId, globalId, "org");
      const own = await mkChallenge(viewerId, globalId, "org");
      const hidden = await mkChallenge(otherId, nsId, "namespace"); // restricted to a namespace the viewer is not in
      const triage = await mkChallenge(otherId, globalId, "org", "awaiting_triage"); // hidden until triaged

      assert.equal(await countNewChallenges(pool, viewer), 2, "the org challenge + the viewer's own; never the restricted or the untriaged one");
      assert.equal(await countNewChallenges(pool, insider), 4, "the insider (the author of the rest) sees the restricted and the untriaged one too");

      const open = await listChallenges(pool, viewer, { tab: "open", sort: "newest" });
      const byId = new Map(open.map((c) => [c.id, c]));
      assert.equal(byId.get(visible)?.isNew, true, "the card carries the flag");
      assert.equal(byId.get(own)?.isNew, true, "own submissions count like anyone else's");
      assert.equal(byId.has(hidden), false);
      assert.equal(byId.has(triage), false);

      // Leaving the surface advances the marker: nothing is new until a NEWER challenge arrives.
      await markChallengesSeen(pool, viewerId);
      assert.equal(await countNewChallenges(pool, viewer), 0);
      assert.equal((await listChallenges(pool, viewer, { tab: "open", sort: "newest" })).find((c) => c.id === visible)?.isNew, false);

      // A new solution or comment on an existing challenge does not make it new — only creation does.
      await pool.query(`insert into comments (parent_type, parent_id, author_id, body) values ('challenge', $1, $2, 'later')`, [visible, otherId]);
      assert.equal(await countNewChallenges(pool, viewer), 0);

      const later = await mkChallenge(otherId, globalId, "org");
      assert.equal(await countNewChallenges(pool, viewer), 1);
      assert.equal((await listChallenges(pool, viewer, { tab: "open", sort: "newest" })).find((c) => c.id === later)?.isNew, true);
      assert.equal(await countNewChallenges(pool, insider), 5, "another viewer's marker is untouched");
    } finally {
      await pool.end();
    }
  },
);

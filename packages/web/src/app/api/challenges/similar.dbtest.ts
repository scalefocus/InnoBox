// Live-DB integration test (gated) for the §6.1 duplicate warning: matches come only from the
// viewer's visible challenges, rejected/withdrawn are excluded while solved is kept, a single
// shared word is not enough, anonymous authors are masked, at most five come back, and the
// acknowledgement lands in the challenge.created audit payload. Self-skips when DATABASE_URL
// is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "similar challenges: visibility, status exclusions, threshold, masking, cap, audit acknowledgement",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const { createChallenge, findSimilarChallenges, SIMILAR_LIMIT } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      // A made-up stem pair unique to this run, so other suites' fixtures never match.
      const w1 = `zorblax${stamp.replace(/[^a-z]/g, "q")}`;
      const w2 = `quuxifier${stamp.replace(/[^a-z]/g, "q")}`;

      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: ns } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, 'Dbtest Similar NS') returning id`, [`dbtest-sim-${stamp}`]);
      const nsId = ns[0]!.id;
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);
      const impactAreaId = ia[0]!.id;
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-sim-${label}-${stamp}`, `dbtest-sim-${label}-${stamp}@example.test`, `Dbtest Similar ${label}`],
        );
        return rows[0]!.id;
      };
      const viewerId = await mkUser("viewer");
      const otherId = await mkUser("other");
      const viewer = { userId: viewerId, roles: buildRoleSet([], { globalNamespaceId: globalId }) };

      const mk = async (title: string, opts: { status?: string; namespaceId?: string; visibility?: string; anonymous?: boolean; description?: string } = {}) => {
        const { rows } = await pool.query<{ number: number }>(
          `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status, is_anonymous)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning number`,
          [opts.namespaceId ?? globalId, opts.visibility ?? "org", title, opts.description ?? "fixture", impactAreaId, otherId, opts.status ?? "valid", opts.anonymous ?? false],
        );
        return `CH-${rows[0]!.number}`;
      };

      const valid = await mk(`The ${w1} ${w2} problem`);
      const solved = await mk(`Solved ${w1} ${w2} case`, { status: "solved" });
      const anonymous = await mk(`Anonymous ${w1} ${w2} idea`, { anonymous: true });
      const rejected = await mk(`Rejected ${w1} ${w2} item`, { status: "rejected" });
      const withdrawn = await mk(`Withdrawn ${w1} ${w2} item`, { status: "withdrawn" });
      const restricted = await mk(`Restricted ${w1} ${w2} item`, { namespaceId: nsId, visibility: "namespace" });
      const untriaged = await mk(`Untriaged ${w1} ${w2} item`, { status: "awaiting_triage" });
      const oneWord = await mk(`Only ${w1} here`);
      const viaDescription = await mk("A plain title", { description: `This one talks about ${w1} and ${w2} at length.` });

      const results = await findSimilarChallenges(pool, viewer, { title: `How do we fix ${w1} ${w2}?`, description: "" });
      const numbers = results.map((r) => r.number);
      assert.ok(numbers.includes(valid), "a visible match");
      assert.ok(numbers.includes(solved), "solved is kept — the most useful hit");
      assert.ok(numbers.includes(anonymous));
      assert.ok(numbers.includes(viaDescription), "terms in the description count too");
      for (const hidden of [rejected, withdrawn, restricted, untriaged]) assert.ok(!numbers.includes(hidden), `${hidden} must never appear`);
      assert.ok(!numbers.includes(oneWord), "one shared word is below the minimum rank");
      assert.ok(results.length <= SIMILAR_LIMIT);
      assert.equal(results[0]!.number === valid || results[0]!.number === solved || results[0]!.number === anonymous, true, "title matches outrank description matches");

      const anon = results.find((r) => r.number === anonymous)!;
      assert.equal(anon.author.anonymous, true);
      assert.equal(anon.author.userId, null, "the true author never leaves the API");

      // The cap: more than five matches still returns five.
      for (let i = 0; i < 4; i++) await mk(`Extra ${w1} ${w2} number ${i}`);
      assert.equal((await findSimilarChallenges(pool, viewer, { title: `${w1} ${w2}`, description: "" })).length, SIMILAR_LIMIT);

      // Nothing to rank on → nothing found; unrelated text → nothing found.
      assert.deepEqual(await findSimilarChallenges(pool, viewer, { title: "the and of", description: "" }), [], "stop words alone yield no terms");
      assert.deepEqual(await findSimilarChallenges(pool, viewer, { title: `unrelated${stamp.replace(/[^a-z]/g, "x")} words`, description: "" }), []);

      // Quote-like characters in the text cannot break the tsquery.
      await findSimilarChallenges(pool, viewer, { title: `it's ${w1}'s "${w2}" & | ! :*`, description: "(x)" });

      // The acknowledgement lands in the audit payload — and is absent when there was none.
      const ok = await createChallenge(pool, viewer, {
        impactAreaId,
        namespaceId: globalId,
        title: `Submitted anyway ${stamp}`,
        description: "after seeing the warning",
        clientName: null,
        visibility: "org",
        isAnonymous: false,
        similarAcknowledged: [valid, solved],
      });
      assert.equal(ok.status, "ok");
      const plain = await createChallenge(pool, viewer, {
        impactAreaId,
        namespaceId: globalId,
        title: `No warning ${stamp}`,
        description: "nothing similar",
        clientName: null,
        visibility: "org",
        isAnonymous: false,
      });
      assert.equal(plain.status, "ok");
      if (ok.status !== "ok" || plain.status !== "ok") return;
      const audit = async (id: string) =>
        (await pool.query<{ after: Record<string, unknown> }>(`select after from audit_log where action = 'challenge.created' and target_id = $1`, [id])).rows[0]!.after;
      assert.deepEqual((await audit(ok.challenge.id)).similarAcknowledged, [valid, solved]);
      assert.equal("similarAcknowledged" in (await audit(plain.challenge.id)), false);
    } finally {
      await pool.end();
    }
  },
);

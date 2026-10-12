// Live-DB integration test (gated) for "Similar challenges, explained" (INNOBOX_SPEC.md §22.12): the
// switch; re-ranking with reasons closed over the §6.1 set; namespace-only candidates dropped from
// the AI input (but kept in the list) while restricted content may not be sent; a namespace-only
// draft not sent at all; silent fallback to the plain list on a provider error and on a timeout.
// The provider is a local stub. Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "similar explained: switch, closed re-ranking, restricted dropping, silent fallback",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID, randomBytes } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const support = await import("./dbtest-support");
    const { explainSimilar } = await import("./similar");
    const { findSimilarChallengeCandidates } = await import("../challenges/store");

    const pool = new Pool({ connectionString: url });
    const stub = await support.startProviderStub();
    try {
      const key = randomBytes(32);
      const ai = support.testAiClient(pool, key);
      await support.configureAi(pool, key, stub.baseUrl);
      await support.setSwitch(pool, "ai_duplicate_explain_enabled", false);
      await support.setSwitch(pool, "ai_restricted_content_enabled", false);

      const stamp = randomUUID().slice(0, 8);
      const word = `zq${stamp.replace(/[^a-z]/g, "x")}`;
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: n } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, $1) returning id`, [`dbtest-sim-${stamp}`]);
      const nsId = n[0]!.id;
      const { rows: u } = await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, 'Dbtest Sim Author') returning id`, [`dbtest-sim-${stamp}`, `dbtest-sim-${stamp}@example.test`]);
      const viewer = { userId: u[0]!.id, roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where name = 'Internal'`);
      const mk = async (title: string, visibility: string, namespaceId: string) =>
        (
          await pool.query<{ number: string }>(
            `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status, is_anonymous)
             values ($1, $2, $3, $4, $5, $6, 'valid', true) returning number::text`,
            [namespaceId, visibility, title, `About ${word} invoices. ${"x".repeat(700)}`, ia[0]!.id, viewer.userId],
          )
        ).rows[0]!.number;
      const orgA = await mk(`${word} invoice matching`, "org", globalId);
      const orgB = await mk(`${word} invoice approvals`, "org", globalId);
      const restricted = await mk(`${word} invoice archive`, "namespace", nsId);

      const draft = { title: `${word} invoice matching`, description: `${word} invoices are matched by hand`, visibility: "org" as const };
      const candidates = await findSimilarChallengeCandidates(pool, viewer, draft);
      const numbers = candidates.map((c) => c.number).sort();
      assert.deepEqual(numbers, [`CH-${orgA}`, `CH-${orgB}`, `CH-${restricted}`].sort());

      stub.reply((call) => {
        const nums = [...call.user.matchAll(/^#(\d+)/gm)].map((m) => Number(m[1]));
        return { text: JSON.stringify({ ranking: [...nums].reverse().map((x) => ({ number: x, reason: `reason ${x}` })).concat([{ number: 424242, reason: "invented" }]) }) };
      });

      // Switch off → the plain list, nothing sent.
      let out = await explainSimilar(pool, ai, viewer.userId, draft, candidates);
      assert.equal(out.explained, false);
      assert.equal(stub.calls.length, 0);
      assert.ok(out.similar.every((m) => !("reason" in m) && !("excerpt" in m) && !("visibility" in m)), "internal fields never leave");

      // On: re-ranked with reasons; the restricted candidate was not sent but stays, unranked, last.
      await support.setSwitch(pool, "ai_duplicate_explain_enabled", true);
      out = await explainSimilar(pool, ai, viewer.userId, draft, candidates);
      assert.equal(out.explained, true);
      assert.equal(out.similar.length, 3, "closed over the §6.1 set");
      assert.equal(out.similar.at(-1)?.number, `CH-${restricted}`);
      assert.equal(out.similar.at(-1)?.reason, undefined);
      assert.ok(out.similar.slice(0, 2).every((m) => m.reason?.startsWith("reason ")));
      const sent = stub.calls.at(-1)!.user;
      assert.ok(!sent.includes(`#${restricted} `), "restricted candidate not sent");
      assert.ok(!sent.includes("x".repeat(501)), "first 500 characters only");
      assert.ok(!sent.includes("Dbtest Sim Author"));
      assert.ok(!JSON.stringify(out.similar).includes("424242"), "never adds a challenge");

      // A namespace-only draft is restricted: not sent while the switch is off.
      const callsBefore = stub.calls.length;
      out = await explainSimilar(pool, ai, viewer.userId, { ...draft, visibility: "namespace" }, candidates);
      assert.equal(out.explained, false);
      assert.equal(stub.calls.length, callsBefore);

      // Restricted allowed → the restricted candidate is sent and ranked too.
      await support.setSwitch(pool, "ai_restricted_content_enabled", true);
      out = await explainSimilar(pool, ai, viewer.userId, draft, candidates);
      assert.ok(stub.calls.at(-1)!.user.includes(`#${restricted} `));
      assert.ok(out.similar.every((m) => m.reason));
      await support.setSwitch(pool, "ai_restricted_content_enabled", false);

      // Silent fallback: a provider error…
      stub.reply(() => ({ status: 500 }));
      out = await explainSimilar(pool, ai, viewer.userId, draft, candidates);
      assert.equal(out.explained, false);
      assert.equal(out.similar.length, 3);
      // …and a timeout (the stub answers after 1.5 s; the step gives up after 0.3 s here, 5 s live).
      stub.reply(() => ({ text: "{}", delayMs: 1_500 }));
      const started = Date.now();
      out = await explainSimilar(pool, ai, viewer.userId, draft, candidates, { timeoutMs: 300 });
      assert.equal(out.explained, false);
      assert.ok(Date.now() - started < 1_200, `fell back in ${Date.now() - started} ms`);
      const { rows: usage } = await pool.query<{ error_code: string | null }>(
        `select error_code from ai_usage where feature = 'duplicate_explain' and user_id = $1 order by id`,
        [viewer.userId],
      );
      assert.deepEqual(usage.slice(-2).map((r) => r.error_code), ["ai_provider_error", "ai_cancelled"], "both recorded; the timeout as a cancellation");
    } finally {
      await pool.query(`delete from ai_integration`).catch(() => {});
      await support.setSwitch(pool, "ai_duplicate_explain_enabled", false).catch(() => {});
      await stub.close();
      await pool.end();
    }
  },
);

// Live-DB integration test (gated) for "Improve with AI" (INNOBOX_SPEC.md §22.10): availability
// (configured + enabled), the restricted-content refusal before any network call, the per-user
// limits counted from ai_usage (10 a minute, 50 a day), a solution draft that sees its challenge
// only when the caller can, and the egress — no client name, no anonymity flag. The provider is a
// local stub. Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "Improve with AI: availability, restricted content, per-user limits, egress",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID, randomBytes } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const support = await import("../dbtest-support");
    const { getDraftAvailability, runDraft } = await import("./store");

    const pool = new Pool({ connectionString: url });
    const stub = await support.startProviderStub();
    try {
      const key = randomBytes(32);
      const ai = support.testAiClient(pool, key);
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const mkUser = async (name: string) =>
        (await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`, [`dbtest-draft-${name}-${stamp}`, `dbtest-draft-${name}-${stamp}@example.test`, `Dbtest Draft ${name}`])).rows[0]!.id;
      const authorId = await mkUser("author");
      const otherId = await mkUser("other");
      const viewer = { userId: authorId, roles: buildRoleSet([], { globalNamespaceId: globalId }) };
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where name = 'Internal'`);
      const { rows: ns } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, $2) returning id`, [`dbtest-draft-${stamp}`, `Dbtest Draft ${stamp}`]);
      const mkChallenge = async (visibility: "org" | "namespace", namespaceId: string) =>
        (
          await pool.query<{ number: string }>(
            `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status, is_anonymous, client_name)
             values ($1, $2, 'Parent challenge title', 'Parent challenge text', $3, $4, 'valid', true, null) returning number::text`,
            [namespaceId, visibility, ia[0]!.id, otherId],
          )
        ).rows[0]!.number;
      const orgChallenge = await mkChallenge("org", globalId);
      const hiddenChallenge = await mkChallenge("namespace", ns[0]!.id);

      const challengeReq = { kind: "challenge" as const, title: "Invoices", description: "We match invoices by hand.", visibility: "org" as const };

      // Not configured → unavailable, nothing sent.
      await pool.query(`delete from ai_integration`);
      assert.deepEqual(await getDraftAvailability(pool, ai), { available: false, restrictedAllowed: false });
      assert.equal((await runDraft(pool, ai, viewer, challengeReq)).status, "unavailable");

      await support.configureAi(pool, key, stub.baseUrl);
      await support.setSwitch(pool, "ai_restricted_content_enabled", false);
      assert.deepEqual(await getDraftAvailability(pool, ai), { available: true, restrictedAllowed: false });

      stub.reply((call) => {
        if (call.system.includes("challenge (a problem worth solving)")) return { text: JSON.stringify({ title: "Manual invoice matching", description: "Problem\nInvoices are matched by hand.", impactArea: "internal" }) };
        return { text: JSON.stringify({ description: "Pre-match with OCR.", costVsBenefits: "Costs: two weeks. Benefits: hours saved." }) };
      });

      // A challenge draft: plain fields back, the hint mapped to the active area.
      const ok = await runDraft(pool, ai, viewer, challengeReq);
      assert.equal(ok.status, "ok");
      if (ok.status === "ok" && ok.kind === "challenge") {
        assert.equal(ok.draft.title, "Manual invoice matching");
        assert.deepEqual(ok.draft.impactArea, { id: ia[0]!.id, name: "Internal" });
      }
      assert.equal(stub.calls.length, 1);
      const { rows: usage } = await pool.query(`select feature, user_id, ok from ai_usage where user_id = $1`, [authorId]);
      assert.deepEqual(usage, [{ feature: "submit_draft", user_id: authorId, ok: true }]);
      const { rows: audits } = await pool.query(`select 1 from audit_log where actor_user_id = $1`, [authorId]);
      assert.equal(audits.length, 0, "no audit");

      // Restricted: a namespace-only challenge is refused before any call while the switch is off.
      assert.equal((await runDraft(pool, ai, viewer, { ...challengeReq, visibility: "namespace" })).status, "restricted");
      assert.equal(stub.calls.length, 1, "nothing sent");

      // A solution draft: the parent challenge must be visible; it is context, never the client
      // name or the anonymity flag.
      const sol = await runDraft(pool, ai, viewer, { kind: "solution", challengeNumber: orgChallenge, description: "OCR", costVsBenefits: "" });
      assert.equal(sol.status, "ok");
      const sent = stub.calls.at(-1)!;
      assert.ok(sent.user.includes("Parent challenge title") && sent.user.includes("Parent challenge text"));
      assert.ok(!/anonym/i.test(sent.user) && !sent.user.includes("Dbtest Draft"), "no anonymity flag, no names");
      assert.equal((await runDraft(pool, ai, viewer, { kind: "solution", challengeNumber: hiddenChallenge, description: "x", costVsBenefits: "" })).status, "not_found", "a challenge the caller cannot see");

      // Restricted switch on → a namespace-only challenge may be sent.
      await support.setSwitch(pool, "ai_restricted_content_enabled", true);
      assert.equal((await getDraftAvailability(pool, ai)).restrictedAllowed, true);
      assert.equal((await runDraft(pool, ai, viewer, { ...challengeReq, visibility: "namespace" })).status, "ok");
      await support.setSwitch(pool, "ai_restricted_content_enabled", false);

      // A provider failure → failed (the route shows the plain message), recorded as usage.
      stub.reply(() => ({ status: 500 }));
      assert.equal((await runDraft(pool, ai, viewer, challengeReq)).status, "failed");
      assert.equal(stub.calls.length, 4, "retry: false — one attempt");

      // Limits: 10 in the last minute, then 50 in 24 hours (counted from ai_usage, every outcome).
      const add = (n: number, ago: string) =>
        pool.query(
          `insert into ai_usage (created_at, feature, user_id, provider, model, latency_ms, ok)
           select now() - $3::interval, 'submit_draft', $1, 'openwebui', 'stub-model', 1, true from generate_series(1, $2)`,
          [authorId, n, ago],
        );
      await add(6, "5 seconds"); // 4 real rows already + 6 = 10 in the last minute
      assert.equal((await runDraft(pool, ai, viewer, challengeReq)).status, "minute");
      await pool.query(`update ai_usage set created_at = now() - interval '2 hours' where user_id = $1`, [authorId]);
      await add(40, "3 hours");
      assert.equal((await runDraft(pool, ai, viewer, challengeReq)).status, "day");
      assert.equal(stub.calls.length, 4, "limits refuse before any call");
      const otherViewer = { userId: otherId, roles: viewer.roles };
      stub.reply(() => ({ text: JSON.stringify({ title: "t", description: "d" }) }));
      assert.equal((await runDraft(pool, ai, otherViewer, challengeReq)).status, "ok", "limits are per person");

      // Disabled → unavailable.
      await pool.query(`update ai_integration set enabled = false`);
      assert.equal((await runDraft(pool, ai, viewer, challengeReq)).status, "unavailable");
    } finally {
      await pool.query(`delete from ai_integration`).catch(() => {});
      await stub.close();
      await pool.end();
    }
  },
);

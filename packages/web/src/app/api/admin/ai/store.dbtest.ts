// Live-DB integration test (gated) for the §22 AI plumbing (INNOBOX_SPEC.md §22.9): the provider is
// stubbed by a LOCAL HTTP server (the non-production localhost allowance), never the internet.
// Covers: ai_key_missing; save-pass persists encrypted and audits (never the key), save-fail
// persists nothing, an identical save is a no-op; the stored-token rule; only a test of the saved
// configuration updates last_test_*; enable gating; disable → ai_disabled; the view never carries
// the key; one usage row per retried call; the 15-minute system-log throttle under concurrency;
// the display name, timeouts and switches; remove keeps ai_usage; the prune; GDPR erasure.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "AI plumbing: provider card store, helper recording, throttle, prune, erasure",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const http = await import("node:http");
    const { Pool } = await import("pg");
    const { randomUUID, randomBytes } = await import("node:crypto");
    const ai = await import("@innobox/shared/ai");
    const store = await import("./store");
    const { scrubUser } = await import("../../users/store");

    const pool = new Pool({ connectionString: url });
    const TOKEN = "sk-DBTESTSECRET0001";
    let failNext = 0;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { detail: "Invalid API key" });
        if (req.url === "/api/models") return send(200, { data: [{ id: "stub-a" }, { id: "stub-b" }] });
        if (failNext > 0) {
          failNext--;
          return send(503, { error: { message: "busy" } });
        }
        const model = (JSON.parse(body || "{}") as { model?: string }).model;
        if (model === "broken") return send(400, { error: { message: "no such model" } });
        send(200, { model, choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 1 } });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    try {
      // A clean slate for the single row and its settings (this suite owns them).
      await pool.query(`delete from ai_integration`);
      await pool.query(`delete from ai_usage`);
      const stamp = randomUUID().slice(0, 8);
      const { rows: u } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
        [`dbtest-ai-${stamp}`, `dbtest-ai-${stamp}@example.test`, "Dbtest AI Admin"],
      );
      const adminId = u[0]!.id;
      const key = randomBytes(32);
      const deps = { key, transport: { allowLocalhost: true } };
      const cfg = { provider: "openwebui" as const, baseUrl: `${base}/api`, token: TOKEN, model: "stub-a" };

      // Without the key every provider write is refused; the view says so.
      const noKey = { key: null, transport: { allowLocalhost: true } };
      assert.deepEqual(await store.saveAiConfig(pool, noKey, adminId, cfg), { ok: false, status: "key_missing" });
      assert.deepEqual(await store.setAiEnabled(pool, noKey, adminId, true), { ok: false, status: "key_missing" });
      assert.deepEqual(await store.removeAiConfig(pool, noKey, adminId), { ok: false, status: "key_missing" });
      assert.equal((await store.getAiAdminView(pool, noKey)).keyPresent, false);

      // Not configured.
      const empty = await store.getAiAdminView(pool, deps);
      assert.equal(empty.status.state, "not_configured");
      assert.equal(empty.config, null);
      assert.deepEqual(await store.setAiEnabled(pool, deps, adminId, true), { ok: false, status: "not_configured" });

      // A blank key with nothing saved is refused before any network call.
      const blank = await store.testAiConfig(pool, deps, adminId, { ...cfg, token: "" });
      assert.equal(!blank.ok && blank.status, "token_required");

      // Save-fail persists nothing (but the test is recorded as usage).
      const failed = await store.saveAiConfig(pool, deps, adminId, { ...cfg, model: "broken" });
      assert.equal(!failed.ok && failed.status, "test_failed");
      // §22.5: the diagnostic (host + status) is handed back for the system log only.
      const failure = !failed.ok && failed.status === "test_failed" ? failed.failure : null;
      assert.equal(failure?.code, "ai_provider_error");
      assert.equal(failure?.diagnostic, "HTTP 400: no such model — HTTP 400 from 127.0.0.1");
      assert.ok(!JSON.stringify(!failed.ok && failed.status === "test_failed" ? failed.result : null).includes("from 127.0.0.1"), "never in the result");
      assert.equal(await ai.readAiIntegration(pool), null);
      const { rows: testRows } = await pool.query(`select feature, user_id, ok from ai_usage`);
      assert.deepEqual(testRows, [{ feature: "test", user_id: adminId, ok: false }]);

      // Save-pass persists the normalized URL, the ciphertext and last 4 — and audits without the key.
      const saved = await store.saveAiConfig(pool, deps, adminId, cfg);
      assert.deepEqual(saved, { ok: true, status: "saved" });
      const row = (await ai.readAiIntegration(pool))!;
      assert.equal(row.baseUrl, base, "the trailing /api is stripped");
      assert.equal(row.enabled, false, "saving never enables");
      assert.equal(row.tokenLast4, "0001");
      assert.ok(!row.tokenEnc.includes(TOKEN));
      assert.equal(ai.decryptAiToken(row.tokenEnc, key), TOKEN);
      assert.equal(row.lastTestOk, true);
      assert.equal(row.lastTestModel, "stub-a");
      const { rows: audits } = await pool.query<{ action: string; before: unknown; after: Record<string, unknown> }>(
        `select action, before, after from audit_log where actor_user_id = $1 and action like 'ai.%' order by id`,
        [adminId],
      );
      assert.deepEqual(audits.map((a) => a.action), ["ai.config_updated"]);
      assert.equal(audits[0]!.before, null);
      assert.deepEqual(audits[0]!.after, { provider: "openwebui", baseUrl: base, model: "stub-a", token_rotated: true });
      assert.ok(!JSON.stringify(audits).includes("0001") && !JSON.stringify(audits).includes(TOKEN), "never the key or its last 4");

      // An identical save is a no-op (no test, no audit) — blank key or the same key re-typed.
      const usageBefore = (await pool.query(`select count(*)::int as n from ai_usage`)).rows[0].n as number;
      assert.deepEqual(await store.saveAiConfig(pool, deps, adminId, { ...cfg, token: "" }), { ok: true, status: "noop" });
      assert.deepEqual(await store.saveAiConfig(pool, deps, adminId, cfg), { ok: true, status: "noop" });
      assert.equal((await pool.query(`select count(*)::int as n from ai_usage`)).rows[0].n, usageBefore);

      // The stored-token rule: a changed provider or base URL needs the key again.
      const moved = await store.testAiConfig(pool, deps, adminId, { ...cfg, baseUrl: "http://localhost:1/api", token: "" });
      assert.equal(!moved.ok && moved.status, "token_required");
      const switched = await store.loadAiModels(pool, deps, { provider: "openai", baseUrl: base, token: "" });
      assert.equal(!switched.ok && switched.status, "token_required");
      const models = await store.loadAiModels(pool, deps, { provider: "openwebui", baseUrl: base, token: "" });
      assert.deepEqual(models, { ok: true, models: ["stub-a", "stub-b"] });

      // Only a test of exactly the saved configuration updates last_test_*.
      const other = await store.testAiConfig(pool, deps, adminId, { ...cfg, model: "broken", token: "" });
      assert.ok(other.ok && !other.result.ok);
      assert.match(other.ok ? (other.failure?.diagnostic ?? "") : "", / — HTTP 400 from 127\.0\.0\.1$/);
      assert.equal((await ai.readAiIntegration(pool))!.lastTestOk, true, "a different model leaves last_test_* alone");

      // Enable gating: a failing test of the saved config blocks enabling.
      await pool.query(`update ai_integration set last_test_ok = false`);
      assert.deepEqual(await store.setAiEnabled(pool, deps, adminId, true), { ok: false, status: "test_required" });
      const retest = await store.testAiConfig(pool, deps, adminId, { ...cfg, token: "" });
      assert.ok(retest.ok && retest.result.ok);
      assert.equal(retest.ok && retest.failure, null, "a pass hands back no failure");
      assert.equal((await ai.readAiIntegration(pool))!.lastTestOk, true, "the saved config's test refreshes last_test_*");
      assert.deepEqual(await store.setAiEnabled(pool, { ...deps, key: randomBytes(32) }, adminId, true), { ok: false, status: "token_undecryptable" });
      assert.deepEqual(await store.setAiEnabled(pool, deps, adminId, true), { ok: true, changed: true });
      assert.deepEqual(await store.setAiEnabled(pool, deps, adminId, true), { ok: true, changed: false });

      const view = await store.getAiAdminView(pool, deps);
      assert.equal(view.status.state, "operational");
      assert.equal(view.enableBlocker, null);
      assert.equal(view.config?.tokenLast4, "0001");
      assert.ok(!JSON.stringify(view).includes(TOKEN) && !JSON.stringify(view).includes(row.tokenEnc), "the view never carries the key");
      assert.ok(view.usage.byFeature.some((f) => f.feature === "test" && f.label === "Connection tests"));

      // The helper: one usage row per retried call; a failing call flips the pill and logs once.
      const features = [{ key: "dbtest_task", label: "Dbtest task", egress: "Nothing real." }];
      const client = ai.createAiClient({ db: pool, key, source: "web", transport: { allowLocalhost: true }, features, sleep: async () => {} });
      assert.equal(await client.available("dbtest_task"), true);
      failNext = 1;
      const okCall = await client.complete({ feature: "dbtest_task", userId: adminId, messages: [{ role: "user", content: "hi" }] });
      assert.equal(okCall.text, "OK");
      const { rows: taskRows } = await pool.query(`select ok, input_tokens, user_id from ai_usage where feature = 'dbtest_task'`);
      assert.deepEqual(taskRows, [{ ok: true, input_tokens: 7, user_id: adminId }], "retried once, recorded once");

      await pool.query(`update ai_integration set last_failure_logged_at = null`);
      const eventsBefore = (await pool.query(`select count(*)::int as n from system_events where route = '/ai/dbtest_task'`)).rows[0].n as number;
      failNext = 4;
      await assert.rejects(client.complete({ feature: "dbtest_task", messages: [{ role: "user", content: "hi" }] }));
      await assert.rejects(client.complete({ feature: "dbtest_task", messages: [{ role: "user", content: "hi" }] }));
      const { rows: events } = await pool.query<{ status: number; user_id: string | null; path: string; error_code: string; source: string }>(
        `select status, user_id, path, error_code, source from system_events where route = '/ai/dbtest_task' order by id`,
      );
      assert.equal(events.length - eventsBefore, 1, "throttled: one row per 15 minutes");
      assert.deepEqual(events.at(-1), { status: 502, user_id: null, path: "/api/chat/completions", error_code: "ai_provider_error", source: "web" });
      assert.equal((await store.getAiAdminView(pool, deps)).status.state, "failing");

      // The throttle under concurrency: web and worker racing for the slot — exactly one wins.
      await pool.query(`update ai_integration set last_failure_logged_at = null`);
      const races = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          ai.logAiFailure(pool, { source: i % 2 ? "worker" : "web", feature: "dbtest_race", code: "ai_timeout", endpointPath: "/api/chat/completions", message: "timed out" }),
        ),
      );
      assert.equal(races.filter(Boolean).length, 1);
      assert.equal((await pool.query(`select count(*)::int as n from system_events where route = '/ai/dbtest_race'`)).rows[0].n, 1);

      // Disable → every helper call fails fast with ai_disabled; nothing is recorded.
      assert.deepEqual(await store.setAiEnabled(pool, deps, adminId, false), { ok: true, changed: true });
      await assert.rejects(client.complete({ feature: "dbtest_task", messages: [{ role: "user", content: "hi" }] }), (e: unknown) => ai.isAiError(e) && e.code === "ai_disabled");
      assert.equal(await client.available(), false);
      assert.equal((await store.getAiAdminView(pool, deps)).status.state, "off");

      // Independent rows: display name, timeouts (none registered → empty), switches.
      assert.deepEqual(await store.setAiDisplayName(pool, adminId, "  Ada "), { ok: true, displayName: "Ada", changed: true });
      assert.deepEqual(await store.setAiDisplayName(pool, adminId, "Ada"), { ok: true, displayName: "Ada", changed: false });
      assert.equal((await store.setAiDisplayName(pool, adminId, "x".repeat(25))).ok, false);
      assert.equal(await store.getAiDisplayNameSetting(pool), "Ada");
      const timeouts = await store.setAiTimeouts(pool, adminId, { calls: { dbtest_task: 30_000 } }, features);
      assert.deepEqual(timeouts, { ok: true, timeouts: { calls: { dbtest_task: 30_000 } }, changed: true });
      const badTimeout = await store.setAiTimeouts(pool, adminId, { calls: { dbtest_task: 5_000 } }, features);
      assert.equal(!badTimeout.ok && badTimeout.field, "calls.dbtest_task");
      assert.deepEqual(await store.setAiSwitches(pool, adminId, { restrictedContent: true, features: {} }), { changed: ["ai_restricted_content_enabled"] });
      assert.deepEqual(await store.setAiSwitches(pool, adminId, { restrictedContent: true, features: {} }), { changed: [] });
      const { rows: settingAudits } = await pool.query<{ action: string }>(
        `select action from audit_log where actor_user_id = $1 and action like 'settings.ai_%' order by id`,
        [adminId],
      );
      assert.deepEqual(settingAudits.map((a) => a.action), ["settings.ai_display_name_changed", "settings.ai_timeouts_changed", "settings.ai_restricted_content_enabled_changed"]);
      await store.setAiSwitches(pool, adminId, { restrictedContent: false, features: {} });
      await store.setAiDisplayName(pool, adminId, "");
      await store.setAiTimeouts(pool, adminId, { calls: {} }, features);

      // Remove: the row (and key) is gone, usage history stays, idempotent.
      const usageCount = (await pool.query(`select count(*)::int as n from ai_usage`)).rows[0].n as number;
      assert.deepEqual(await store.removeAiConfig(pool, deps, adminId), { ok: true, removed: true });
      assert.deepEqual(await store.removeAiConfig(pool, deps, adminId), { ok: true, removed: false });
      assert.equal(await ai.readAiIntegration(pool), null);
      assert.equal((await pool.query(`select count(*)::int as n from ai_usage`)).rows[0].n, usageCount);
      const { rows: tail } = await pool.query<{ action: string }>(`select action from audit_log where actor_user_id = $1 and action like 'ai.%' order by id`, [adminId]);
      assert.deepEqual(tail.map((a) => a.action), ["ai.config_updated", "ai.enabled", "ai.disabled", "ai.config_cleared"]);

      // Prune: rows past 365 days go, newer ones stay.
      await pool.query(`update ai_usage set created_at = now() - interval '400 days' where feature = 'dbtest_task'`);
      assert.equal(await ai.pruneAiUsage(pool), 3, "the successful call and the two failed ones");
      assert.equal((await pool.query(`select count(*)::int as n from ai_usage where feature = 'dbtest_task'`)).rows[0].n, 0);

      // GDPR erasure nulls ai_usage.user_id and keeps the counts.
      const { rows: other2 } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
        [`dbtest-ai-erase-${stamp}`, `dbtest-ai-erase-${stamp}@example.test`, "Dbtest AI Erase"],
      );
      const subject = other2[0]!.id;
      await ai.recordAiUsage(pool, { feature: "test", userId: subject, provider: "openai", model: "m", inputTokens: 1, outputTokens: 1, latencyMs: 5, ok: true, errorCode: null });
      const scrubbed = await scrubUser(pool, adminId, subject);
      assert.equal(scrubbed.status, "ok");
      assert.equal((await pool.query(`select count(*)::int as n from ai_usage where user_id = $1`, [subject])).rows[0].n, 0);
      assert.equal((await pool.query(`select count(*)::int as n from ai_usage where feature = 'test' and user_id is null and model = 'm'`)).rows[0].n, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await pool.end();
    }
  },
);

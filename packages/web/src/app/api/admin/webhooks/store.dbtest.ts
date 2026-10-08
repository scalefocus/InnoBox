// Live-DB integration test (gated) for the §12.4 webhook admin store: create/list/update/delete
// with the URL stored only encrypted and returned only as a hint; the 5-per-namespace cap
// (sequential and concurrent); the SSRF save-time refusals (form rules, DNS failure, private
// resolution) without touching the network; the key gate; the Send test (injected transport,
// works while disabled, audited, never system-logged); audit rows that never carry the URL;
// and a deleted webhook taking its undelivered rows with it. Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

const TEAMS_URL = "https://prod-12.westeurope.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=SeCrEtx9Zq";

test(
  "webhook admin store: CRUD, hint-only, cap, SSRF refusals, key gate, Send test, audit",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID, randomBytes } = await import("node:crypto");
    const { decryptWebhookUrl } = await import("@innobox/shared/webhook-send");
    const { createWebhook, deleteWebhook, listWebhooks, testWebhook, updateWebhook } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const key = randomBytes(32);
      const publicResolver = async () => [{ address: "20.50.2.3", family: 4 as const }];
      const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
      const deps = {
        key,
        baseUrl: "https://innobox.example.test",
        resolve: publicResolver,
        send: async (input: { url: string; body: string; headers: Record<string, string> }) => {
          sent.push(input);
          return { outcome: "sent" as const, httpStatus: 202, durationMs: 12 };
        },
      };
      const { rows: u } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
        [`dbtest-whadmin-${stamp}`, `dbtest-whadmin-${stamp}@example.test`, "Dbtest WH Admin"],
      );
      const adminId = u[0]!.id;
      const { rows: n } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, $2) returning id`, [
        `dbtest-whadm-${stamp}`,
        `Aaa Dbtest WH ${stamp}`,
      ]);
      const nsId = n[0]!.id;

      // Create: stored encrypted, returned as hint only.
      const created = await createWebhook(pool, deps, adminId, { namespaceId: nsId, name: "Team channel", format: "teams_workflows", url: TEAMS_URL, enabled: true });
      assert.equal(created.status, "ok");
      if (created.status !== "ok") return;
      const hook = created.webhook;
      assert.equal(hook.urlHint, "prod-12.westeurope.logic.azure.com …x9Zq");
      assert.equal(hook.enabled, true);
      assert.equal(hook.lastDelivery, null);
      assert.ok(!JSON.stringify(hook).includes("SeCrEt"), "the URL never comes back");
      const { rows: stored } = await pool.query<{ url_enc: string }>(`select url_enc from channel_webhooks where id = $1`, [hook.id]);
      assert.ok(!stored[0]!.url_enc.includes("logic.azure.com"), "ciphertext at rest");
      assert.equal(decryptWebhookUrl(stored[0]!.url_enc, key), TEAMS_URL);

      // Listing: global first, every namespace present, hint only.
      const list = await listWebhooks(pool);
      assert.equal(list[0]!.slug, "global", "global first");
      const mine = list.find((x) => x.id === nsId)!;
      assert.equal(mine.archived, false);
      assert.deepEqual(mine.webhooks.map((w) => w.id), [hook.id]);
      assert.ok(!JSON.stringify(list).includes("SeCrEt"));

      // Save-time SSRF refusals (422 at the route) — no network involved.
      const refuse = async (u2: string, resolve = publicResolver as () => Promise<{ address: string; family: 4 | 6 }[]>) =>
        createWebhook(pool, { ...deps, resolve }, adminId, { namespaceId: nsId, name: "x", format: "json", url: u2, enabled: true });
      const r1 = await refuse("http://hooks.example.com/x");
      assert.equal(r1.status === "invalid_url" && r1.message, "Webhook URLs must use https on port 443");
      const r2 = await refuse("https://hooks.example.com:8443/x");
      assert.equal(r2.status, "invalid_url");
      const r3 = await refuse("https://internal.example.com/x", async () => [{ address: "10.1.2.3", family: 4 }]);
      assert.equal(r3.status === "invalid_url" && r3.message, "This address is on a private or internal network");
      const r4 = await refuse("https://nowhere.example.com/x", async () => {
        throw new Error("ENOTFOUND");
      });
      assert.equal(r4.status, "invalid_url");
      const r5 = await refuse("https://127.0.0.1/x");
      assert.equal(r5.status, "invalid_url");

      // Unknown namespace → not_found; key unset → not_configured (create, update, test).
      assert.equal((await createWebhook(pool, deps, adminId, { namespaceId: randomUUID(), name: "x", format: "json", url: TEAMS_URL, enabled: true })).status, "not_found");
      const noKey = { ...deps, key: null };
      assert.equal((await createWebhook(pool, noKey, adminId, { namespaceId: nsId, name: "x", format: "json", url: TEAMS_URL, enabled: true })).status, "not_configured");
      assert.equal((await updateWebhook(pool, noKey, adminId, hook.id, { enabled: false })).status, "not_configured");
      assert.equal((await testWebhook(pool, noKey, adminId, hook.id)).status, "not_configured");
      assert.equal((await updateWebhook(pool, deps, adminId, randomUUID(), { enabled: false })).status, "not_found");

      // Update: enabled + name, empty URL keeps the stored one; a new URL replaces it.
      const off = await updateWebhook(pool, deps, adminId, hook.id, { enabled: false, name: "Renamed" });
      assert.equal(off.status === "ok" && off.webhook.enabled, false);
      assert.equal(off.status === "ok" && off.webhook.urlHint, "prod-12.westeurope.logic.azure.com …x9Zq");
      const replaced = await updateWebhook(pool, deps, adminId, hook.id, { url: "https://hooks.example.com/in/zz99" });
      assert.equal(replaced.status === "ok" && replaced.webhook.urlHint, "hooks.example.com …zz99");
      const badUpdate = await updateWebhook(pool, { ...deps, resolve: async () => [{ address: "192.168.1.1", family: 4 as const }] }, adminId, hook.id, { url: "https://evil.example.com/x" });
      assert.equal(badUpdate.status, "invalid_url");

      // Send test: works while disabled, synchronous, test payload, audited.
      const t = await testWebhook(pool, deps, adminId, hook.id, new Date("2026-10-08T10:00:00Z"));
      assert.equal(t.status, "ok");
      if (t.status === "ok") assert.deepEqual(t.result, { ok: true, httpStatus: 202, durationMs: 12 });
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.url, "https://hooks.example.com/in/zz99");
      assert.equal(sent[0]!.headers["x-innobox-event"], "test");
      const card = JSON.parse(sent[0]!.body);
      assert.equal(card.type, "message", "teams_workflows format renders the card envelope");
      assert.equal(card.attachments[0].content.body[0].text, "Test message — this channel is connected to InnoBox");
      const failing = await testWebhook(
        pool,
        { ...deps, send: async () => ({ outcome: "permanent" as const, reason: "http_error" as const, httpStatus: 404, retryAfterMs: null, durationMs: 5 }) },
        adminId,
        hook.id,
      );
      assert.ok(failing.status === "ok" && failing.result.ok === false && failing.result.httpStatus === 404 && failing.result.reason === "http_error");
      const { rows: sysRows } = await pool.query(`select 1 from system_events where path like '/webhooks/%' and message like $1`, [`%Renamed%`]);
      assert.equal(sysRows.length, 0, "a failed test is never system-logged");
      // A URL that no longer decrypts (key rotated) reports undecryptable without sending.
      const rotated = await testWebhook(pool, { ...deps, key: randomBytes(32) }, adminId, hook.id);
      assert.ok(rotated.status === "ok" && rotated.result.reason === "undecryptable");

      // The cap: at most 5 per namespace, also under concurrency.
      const mk = (i: number) => createWebhook(pool, deps, adminId, { namespaceId: nsId, name: `Hook ${i}`, format: "json", url: TEAMS_URL, enabled: true });
      const burst = await Promise.all([1, 2, 3, 4, 5, 6].map(mk));
      assert.equal(burst.filter((r) => r.status === "ok").length, 4, "1 existing + 4 new = 5");
      assert.equal(burst.filter((r) => r.status === "limit_reached").length, 2);
      assert.equal((await mk(7)).status, "limit_reached");
      const { rows: count } = await pool.query<{ n: number }>(`select count(*)::int as n from channel_webhooks where namespace_id = $1`, [nsId]);
      assert.equal(count[0]!.n, 5);

      // lastDelivery reflects the newest finished sent/failed row.
      await pool.query(
        `insert into webhook_deliveries (webhook_id, event, entity_type, entity_id, event_status, occurred_at, status, attempts, last_http_status, last_reason, finished_at)
         values ($1, 'challenge.validated', 'challenge', $2, 'valid', now(), 'failed', 1, 404, 'http_error', now()),
                ($1, 'challenge.validated', 'challenge', $2, 'valid', now(), 'pending', 0, null, null, null)`,
        [hook.id, randomUUID()],
      );
      const listed = (await listWebhooks(pool)).find((x) => x.id === nsId)!.webhooks.find((w) => w.id === hook.id)!;
      assert.deepEqual({ ...listed.lastDelivery, at: undefined }, { outcome: "failed", at: undefined, httpStatus: 404, reason: "http_error" });

      // Delete takes its delivery rows with it.
      assert.equal((await deleteWebhook(pool, adminId, hook.id)).status, "ok");
      assert.equal((await deleteWebhook(pool, adminId, hook.id)).status, "not_found");
      const { rows: left } = await pool.query(`select 1 from webhook_deliveries where webhook_id = $1`, [hook.id]);
      assert.equal(left.length, 0);

      // Audit: created/updated/tested/deleted, never the URL; updated carries urlChanged.
      const { rows: audit } = await pool.query<{ action: string; before: unknown; after: Record<string, unknown> | null }>(
        `select action, before, after from audit_log where actor_user_id = $1 and action like 'webhook.%' order by id`,
        [adminId],
      );
      const actions = audit.map((a) => a.action);
      assert.ok(actions.includes("webhook.created") && actions.includes("webhook.updated") && actions.includes("webhook.tested") && actions.includes("webhook.deleted"));
      const updates = audit.filter((a) => a.action === "webhook.updated");
      assert.deepEqual(updates.map((a) => a.after?.urlChanged), [false, true]);
      const tested = audit.filter((a) => a.action === "webhook.tested").map((a) => a.after);
      assert.deepEqual(tested[0], { outcome: "delivered", httpStatus: 202, reason: null });
      assert.deepEqual(tested[1], { outcome: "failed", httpStatus: 404, reason: "http_error" });
      const text = JSON.stringify(audit);
      assert.ok(!text.includes("SeCrEt") && !text.includes("/in/zz99") && !text.includes("https://"), "no URL in any audit row");
    } finally {
      await pool.end();
    }
  },
);

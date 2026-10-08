// Live-DB integration test (gated) for the §12.4 delivery sweep, with an INJECTED transport (a
// local fake — never the internet): enqueue → deliver (payload, headers, title read at send);
// retryable failures walk the 1m/5m/15m/1h/4h schedule to a final failure after 6 attempts; a
// permanent failure stops at once; final failures land in the system log (source = worker,
// receiver status or synthetic 502/504, fixed codes, never the URL); the second leak guard skips
// an item that became namespace-restricted, was withdrawn, or was deleted — with no system-log
// row; disabled webhooks are skipped; undecryptable URLs and a missing key fail for good; and the
// 30-day trim removes only old terminal rows. Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "webhook delivery sweep: deliver, retry schedule, final failure → system log, leak guard, trim",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID, randomBytes } = await import("node:crypto");
    const { encryptWebhookUrl } = await import("@innobox/shared/webhook-send");
    const { runWebhookDeliverySweep, trimWebhookDeliveries } = await import("./deliver.js");

    const pool = new Pool({ connectionString: url });
    try {
      // Rows other suites may have left pending would be picked up by the sweep; settle them so
      // only this suite's rows are in play (ephemeral test database).
      await pool.query(`update webhook_deliveries set status = 'skipped', finished_at = now() where status = 'pending'`);

      const stamp = randomUUID().slice(0, 8);
      const key = randomBytes(32);
      const slug = `dbtest-whd-${stamp}`;
      const { rows: n } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, 'Dbtest WHD') returning id`, [slug]);
      const nsId = n[0]!.id;
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);
      const { rows: u } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
        [`dbtest-whd-${stamp}`, `dbtest-whd-${stamp}@example.test`, "Dbtest WHD"],
      );
      const authorId = u[0]!.id;
      const HOOK_URL = "https://hooks.example.com/in/secret-token-1234";
      const mkHook = async (name: string, opts: { enabled?: boolean; format?: string; enc?: string } = {}) =>
        (
          await pool.query<{ id: string }>(
            `insert into channel_webhooks (namespace_id, name, format, url_enc, url_hint, enabled) values ($1, $2, $3, $4, 'hooks.example.com …1234', $5) returning id`,
            [nsId, name, opts.format ?? "json", opts.enc ?? encryptWebhookUrl(HOOK_URL, key), opts.enabled ?? true],
          )
        ).rows[0]!.id;
      const mkChallenge = async (title: string, status = "valid", visibility = "org") =>
        (
          await pool.query<{ id: string; number: number }>(
            `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
             values ($1, $2, $3, 'sweep', $4, $5, $6) returning id, number`,
            [nsId, visibility, title, ia[0]!.id, authorId, status],
          )
        ).rows[0]!;
      const enqueue = async (webhookId: string, entityType: "challenge" | "solution", entityId: string, event: string, eventStatus: string) =>
        (
          await pool.query<{ id: string }>(
            `insert into webhook_deliveries (webhook_id, event, entity_type, entity_id, event_status, occurred_at)
             values ($1, $2, $3, $4, $5, '2026-10-08T12:34:56.789Z') returning id`,
            [webhookId, event, entityType, entityId, eventStatus],
          )
        ).rows[0]!.id;
      const row = async (id: string) =>
        (
          await pool.query<{ status: string; attempts: number; last_http_status: number | null; last_reason: string | null; finished_at: Date | null; due_in_s: number }>(
            `select status, attempts, last_http_status, last_reason, finished_at, extract(epoch from (next_attempt_at - now()))::float8 as due_in_s
               from webhook_deliveries where id = $1`,
            [id],
          )
        ).rows[0]!;
      const makeDue = (id: string) => pool.query(`update webhook_deliveries set next_attempt_at = now() - interval '1 second' where id = $1`, [id]);
      const sysEvents = async () =>
        (
          await pool.query<{ status: number; method: string; route: string; path: string; error_code: string; message: string; source: string; user_id: string | null }>(
            `select status, method, route, path, error_code, message, source, user_id from system_events where path = $1 order by id`,
            [`/webhooks/${slug}`],
          )
        ).rows;

      type Sent = { url: string; body: string; headers: Record<string, string> };
      const calls: Sent[] = [];
      let next: () => unknown = () => ({ outcome: "sent", httpStatus: 202, durationMs: 3 });
      const deps = {
        key,
        baseUrl: "https://innobox.example.test",
        send: async (input: Sent) => {
          calls.push(input);
          return next() as never;
        },
      };

      // 1. Deliver: payload snapshot status/occurredAt, title read at send, stable delivery id.
      const hook = await mkHook("Team channel");
      const ch = await mkChallenge(`Original title ${stamp}`);
      const d1 = await enqueue(hook, "challenge", ch.id, "challenge.validated", "valid");
      await pool.query(`update challenges set title = $2 where id = $1`, [ch.id, `Edited title ${stamp}`]);
      const s1 = await runWebhookDeliverySweep(pool, deps);
      assert.equal(s1.sent, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url, HOOK_URL, "the decrypted URL is used for the request only");
      assert.equal(calls[0]!.headers["x-innobox-delivery"], d1);
      assert.equal(calls[0]!.headers["x-innobox-event"], "challenge.validated");
      assert.match(calls[0]!.headers["user-agent"]!, /^InnoBox-Webhook\//);
      assert.deepEqual(JSON.parse(calls[0]!.body), {
        schema: "innobox.webhook.v1",
        event: "challenge.validated",
        occurredAt: "2026-10-08T12:34:56Z",
        namespace: slug,
        item: { type: "challenge", number: `CH-${ch.number}`, title: `Edited title ${stamp}`, status: "valid", url: `https://innobox.example.test/challenges/${ch.number}` },
      });
      const r1 = await row(d1);
      assert.equal(r1.status, "sent");
      assert.equal(r1.attempts, 1);
      assert.equal(r1.last_http_status, 202);
      assert.ok(r1.finished_at);

      // 2. Retryable failures follow 1m, 5m, 15m, 1h, 4h, then fail for good on the 6th attempt.
      const sol = await pool.query<{ id: string; number: number }>(
        `insert into solutions (challenge_id, description, author_id, status) values ($1, 'x', $2, 'implemented') returning id, number`,
        [ch.id, authorId],
      );
      const d2 = await enqueue(hook, "solution", sol.rows[0]!.id, "solution.implemented", "implemented");
      next = () => ({ outcome: "retryable", reason: "http_error", httpStatus: 503, retryAfterMs: null, durationMs: 4 });
      const expected = [60, 300, 900, 3600, 14400];
      for (let attempt = 1; attempt <= 5; attempt++) {
        await makeDue(d2);
        const s = await runWebhookDeliverySweep(pool, deps);
        assert.equal(s.retried, 1, `attempt ${attempt} retried`);
        const r = await row(d2);
        assert.equal(r.status, "pending");
        assert.equal(r.attempts, attempt);
        assert.equal(r.last_http_status, 503);
        assert.equal(r.last_reason, "http_error");
        assert.ok(Math.abs(r.due_in_s - expected[attempt - 1]!) < 5, `attempt ${attempt}: next in ~${expected[attempt - 1]} s, got ${r.due_in_s}`);
      }
      // Not due → untouched by a sweep.
      const callsBefore = calls.length;
      await runWebhookDeliverySweep(pool, deps);
      assert.equal(calls.length, callsBefore, "a row is only sent when due");
      await makeDue(d2);
      const s6 = await runWebhookDeliverySweep(pool, deps);
      assert.equal(s6.failed, 1);
      const r2 = await row(d2);
      assert.equal(r2.status, "failed");
      assert.equal(r2.attempts, 6);
      assert.ok(r2.finished_at);
      const solBody = JSON.parse(calls.at(-1)!.body);
      assert.equal(solBody.item.number, `SOL-${sol.rows[0]!.number}`);
      assert.equal(solBody.item.title, `Edited title ${stamp}`, "a solution carries its parent's title");
      assert.equal(solBody.item.url, `https://innobox.example.test/challenges/${ch.number}#SOL-${sol.rows[0]!.number}`);
      let events = await sysEvents();
      assert.equal(events.length, 1, "exactly one system-log row, on the FINAL failure only");
      assert.deepEqual(
        { ...events[0], message: undefined },
        { status: 503, method: "POST", route: "/webhooks/[namespace]", path: `/webhooks/${slug}`, error_code: "webhook_http_error", message: undefined, source: "worker", user_id: null },
      );
      assert.ok(events[0]!.message.includes("Team channel") && events[0]!.message.includes("solution.implemented") && events[0]!.message.includes(`SOL-${sol.rows[0]!.number}`));

      // 3. 429 Retry-After longer than the step wins.
      const d3 = await enqueue(hook, "challenge", ch.id, "challenge.solved", "solved");
      next = () => ({ outcome: "retryable", reason: "http_error", httpStatus: 429, retryAfterMs: 600_000, durationMs: 1 });
      await runWebhookDeliverySweep(pool, deps);
      assert.ok(Math.abs((await row(d3)).due_in_s - 600) < 5, "Retry-After 600 s beats the 60 s step");

      // 4. A permanent failure (404) fails at once; a final timeout records a synthetic 504.
      const d4 = await enqueue(hook, "challenge", ch.id, "challenge.solved", "solved");
      next = () => ({ outcome: "permanent", reason: "http_error", httpStatus: 404, retryAfterMs: null, durationMs: 1 });
      await runWebhookDeliverySweep(pool, deps);
      assert.equal((await row(d4)).status, "failed");
      assert.equal((await row(d4)).attempts, 1);
      const d5 = await enqueue(hook, "challenge", ch.id, "challenge.solved", "solved");
      await pool.query(`update webhook_deliveries set attempts = 5 where id = $1`, [d5]);
      next = () => ({ outcome: "retryable", reason: "timeout", httpStatus: null, retryAfterMs: null, durationMs: 10_000 });
      await runWebhookDeliverySweep(pool, deps);
      assert.equal((await row(d5)).status, "failed");
      events = await sysEvents();
      assert.deepEqual(events.slice(1).map((e) => [e.status, e.error_code]), [
        [404, "webhook_http_error"],
        [504, "webhook_timeout"],
      ]);
      await pool.query(`update webhook_deliveries set status = 'skipped', finished_at = now() where id = $1`, [d3]);

      // 5. Leak guard before send: namespace-restricted, withdrawn, deleted → skipped, never sent,
      //    no system-log row.
      next = () => ({ outcome: "sent", httpStatus: 202, durationMs: 1 });
      const hidden = await mkChallenge(`Hidden ${stamp}`);
      const withdrawn = await mkChallenge(`Withdrawn ${stamp}`);
      const dH = await enqueue(hook, "challenge", hidden.id, "challenge.validated", "valid");
      const dW = await enqueue(hook, "challenge", withdrawn.id, "challenge.validated", "valid");
      const dGone = await enqueue(hook, "challenge", randomUUID(), "challenge.validated", "valid");
      const propSol = await pool.query<{ id: string }>(`insert into solutions (challenge_id, description, author_id, status) values ($1, 'p', $2, 'proposed') returning id`, [
        ch.id,
        authorId,
      ]);
      const dP = await enqueue(hook, "solution", propSol.rows[0]!.id, "solution.implemented", "implemented");
      await pool.query(`update challenges set visibility = 'namespace' where id = $1`, [hidden.id]);
      await pool.query(`update challenges set status = 'withdrawn' where id = $1`, [withdrawn.id]);
      const before = calls.length;
      const s5 = await runWebhookDeliverySweep(pool, deps);
      assert.equal(s5.skipped, 4);
      assert.equal(calls.length, before, "nothing was sent");
      for (const id of [dH, dW, dGone, dP]) {
        const r = await row(id);
        assert.equal(r.status, "skipped");
        assert.equal(r.last_reason, "not_visible");
      }
      assert.equal((await sysEvents()).length, 3, "skips write no system-log row");

      // 6. A disabled webhook skips; an undecryptable URL and a missing key fail for good.
      const disabled = await mkHook("Disabled", { enabled: false });
      const dD = await enqueue(disabled, "challenge", ch.id, "challenge.solved", "solved");
      const rotated = await mkHook("Rotated", { enc: encryptWebhookUrl(HOOK_URL, randomBytes(32)) });
      const dR = await enqueue(rotated, "challenge", ch.id, "challenge.solved", "solved");
      await runWebhookDeliverySweep(pool, deps);
      assert.equal((await row(dD)).status, "skipped");
      assert.equal((await row(dD)).last_reason, "disabled");
      assert.equal((await row(dR)).status, "failed");
      assert.equal((await row(dR)).last_reason, "undecryptable");
      const dK = await enqueue(hook, "challenge", ch.id, "challenge.solved", "solved");
      await runWebhookDeliverySweep(pool, { ...deps, key: null });
      assert.equal((await row(dK)).last_reason, "key_missing");
      events = await sysEvents();
      assert.deepEqual(events.slice(3).map((e) => [e.status, e.error_code]), [
        [502, "webhook_undecryptable"],
        [502, "webhook_key_missing"],
      ]);
      const allText = JSON.stringify(events);
      assert.ok(!allText.includes("secret-token") && !allText.includes("hooks.example.com"), "never the URL");

      // 7. Teams format renders the card envelope.
      const teams = await mkHook("Teams", { format: "teams_workflows" });
      await enqueue(teams, "challenge", ch.id, "challenge.solved", "solved");
      await runWebhookDeliverySweep(pool, deps);
      const teamsBody = JSON.parse(calls.at(-1)!.body);
      assert.equal(teamsBody.type, "message");
      assert.equal(teamsBody.attachments[0].content.body[0].text, "Challenge solved");

      // 8. Trim: terminal rows 30 days after finishing go; pending and recent rows stay.
      const old = await enqueue(hook, "challenge", ch.id, "challenge.solved", "solved");
      await pool.query(`update webhook_deliveries set status = 'sent', finished_at = now() - interval '31 days' where id = $1`, [old]);
      const pending = await enqueue(hook, "challenge", ch.id, "challenge.solved", "solved");
      await pool.query(`update webhook_deliveries set next_attempt_at = now() + interval '1 hour', created_at = now() - interval '40 days' where id = $1`, [pending]);
      const trimmed = await trimWebhookDeliveries(pool);
      assert.ok(trimmed >= 1);
      const { rows: gone } = await pool.query(`select id from webhook_deliveries where id = any($1::uuid[])`, [[old, pending, d1]]);
      assert.deepEqual(gone.map((g) => (g as { id: string }).id).sort(), [pending, d1].sort());
    } finally {
      await pool.end();
    }
  },
);

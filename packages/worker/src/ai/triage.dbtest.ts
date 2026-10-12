// Live-DB integration test (gated) for the §22.11 triage-assist pass (INNOBOX_SPEC.md): the
// switch gates everything; a subject gets one note per distinct input (an unchanged item is never
// re-sent, an edit makes a new run, a Re-run runs again); the candidate set is the same namespace,
// never awaiting_triage / withdrawn / another namespace, and namespace-only items (subject or
// candidate) only while restricted content may be sent; duplicates outside the candidate set are
// dropped; a failure is recorded and not retried at once; a withdrawn challenge's note is deleted;
// nothing about the challenge itself ever changes. The provider is a local stub.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "triage assist sweep: switch, one run per input, candidates, restricted, failure, withdrawn",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const http = await import("node:http");
    const { Pool } = await import("pg");
    const { randomUUID, randomBytes } = await import("node:crypto");
    const ai = await import("@innobox/shared/ai");
    const { runTriageAssistSweep } = await import("./triage.js");

    const pool = new Pool({ connectionString: url });
    const TOKEN = "sk-worker-triage-0001";
    const calls: { system: string; user: string }[] = [];
    let mode: "ok" | "fail" = "ok";
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const p = JSON.parse(body || "{}") as { messages?: { role: string; content: string }[]; model?: string };
        const user = (p.messages ?? []).filter((m) => m.role === "user").map((m) => m.content).join("\n");
        calls.push({ system: p.messages?.[0]?.content ?? "", user });
        res.writeHead(mode === "ok" ? 200 : 400, { "content-type": "application/json" });
        if (mode === "fail") return res.end(JSON.stringify({ error: { message: "bad" } }));
        const nums = [...user.matchAll(/^#(\d+)/gm)].map((m) => Number(m[1]));
        const content = JSON.stringify({
          summary: "A summary.",
          missingInformation: ["Impact"],
          suggestedImpactArea: "Internal",
          questions: ["How often?"],
          duplicates: [...nums.map((n) => ({ number: n, reason: "similar" })), { number: 999999, reason: "invented" }],
        });
        res.end(JSON.stringify({ model: p.model, choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    try {
      const key = randomBytes(32);
      const client = ai.createAiClient({ db: pool, key, source: "worker", transport: { allowLocalhost: true }, sleep: async () => {} });
      const stamp = randomUUID().slice(0, 8);
      const setSwitch = (k: string, on: boolean) =>
        pool.query(
          `insert into platform_settings (key, value, updated_at) values ($1, $2::jsonb, now())
           on conflict (key) do update set value = excluded.value, updated_at = now()`,
          [k, JSON.stringify(on)],
        );
      await pool.query(`delete from ai_integration`);
      await pool.query(
        `insert into ai_integration (id, enabled, provider, base_url, model, token_enc, token_last4, last_test_at, last_test_ok)
         values (true, true, 'openwebui', $1, 'stub', $2, '0001', now(), true)`,
        [base, ai.encryptAiToken(TOKEN, key)],
      );
      await setSwitch("ai_restricted_content_enabled", false);
      await setSwitch("ai_triage_assist_enabled", false);

      const { rows: u } = await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, 'Dbtest Triage Author') returning id`, [`dbtest-triage-${stamp}`, `dbtest-triage-${stamp}@example.test`]);
      const authorId = u[0]!.id;
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where name = 'Internal'`);
      const mkNs = async (slug: string) => (await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, $1) returning id`, [`${slug}-${stamp}`])).rows[0]!.id;
      const ns = await mkNs("dbtest-triage");
      const otherNs = await mkNs("dbtest-triage-other");
      const mk = async (title: string, status: string, opts: { visibility?: string; namespaceId?: string } = {}) =>
        (
          await pool.query<{ id: string; number: string }>(
            `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status, is_anonymous)
             values ($1, $2, $3, 'Invoices are matched by hand.', $4, $5, $6, true) returning id, number::text`,
            [opts.namespaceId ?? ns, opts.visibility ?? "org", title, ia[0]!.id, authorId, status],
          )
        ).rows[0]!;
      const subject = await mk("Invoice matching subject", "awaiting_triage");
      const hiddenSubject = await mk("Invoice matching restricted subject", "in_review", { visibility: "namespace" });
      const candValid = await mk("Invoice matching candidate", "valid");
      const candRestricted = await mk("Invoice matching restricted candidate", "valid", { visibility: "namespace" });
      await mk("Invoice matching awaiting", "awaiting_triage"); // a subject too, but never a candidate
      await mk("Invoice matching withdrawn", "withdrawn");
      await mk("Invoice matching elsewhere", "valid", { namespaceId: otherNs });
      const notSubject = await mk("Invoice matching solved", "solved");

      const result = async (id: string) =>
        (await pool.query<{ status: string; payload: { duplicates: { number: number }[] } | null; input_hash: string | null }>(`select status, payload, input_hash from ai_results where kind = 'triage_assist' and parent_id = $1`, [id])).rows[0];
      const sweep = () => runTriageAssistSweep(pool, client, { namespaceId: ns });

      // Switch off → nothing at all.
      const off = await sweep();
      assert.equal(off.effective, false);
      assert.equal(calls.length, 0);

      // On: both org subjects (the awaiting one too) get notes; the namespace-only one is skipped.
      await setSwitch("ai_triage_assist_enabled", true);
      const first = await sweep();
      assert.equal(first.effective, true);
      assert.equal(first.ready, 2);
      assert.equal((await result(subject.id))?.status, "ready");
      assert.equal(await result(hiddenSubject.id), undefined, "restricted subject skipped");
      assert.equal(await result(notSubject.id), undefined, "a solved challenge is not a subject");
      const sent = calls.find((c) => c.user.includes("Invoice matching subject"))!;
      assert.ok(sent.user.includes(`#${candValid.number} Invoice matching candidate`));
      for (const absent of ["restricted candidate", "Invoice matching awaiting", "withdrawn", "elsewhere", "Dbtest Triage Author"]) {
        assert.ok(!sent.user.includes(absent), absent);
      }
      const dups = (await result(subject.id))!.payload!.duplicates.map((d) => d.number);
      assert.ok(dups.includes(Number(candValid.number)));
      assert.ok(!dups.includes(999999), "a duplicate outside the candidate set is dropped");

      // Unchanged → never re-sent.
      const before = calls.length;
      assert.equal((await sweep()).ran, 0);
      assert.equal(calls.length, before);

      // An edit → a new hash → a new run.
      await pool.query(`update challenges set description = 'Invoices are matched by hand at month-end.' where id = $1`, [subject.id]);
      assert.equal((await sweep()).ran, 1);
      assert.equal(calls.length, before + 1);

      // A Re-run (hash cleared) → runs again.
      await pool.query(`update ai_results set input_hash = null, status = 'pending' where parent_id = $1`, [subject.id]);
      assert.equal((await sweep()).ran, 1);

      // Restricted allowed → the namespace-only subject is noted, restricted candidates included.
      await setSwitch("ai_restricted_content_enabled", true);
      assert.equal((await sweep()).ready, 1);
      assert.equal((await result(hiddenSubject.id))?.status, "ready");
      assert.ok(calls.at(-1)!.user.includes(`#${candRestricted.number} Invoice matching restricted candidate`));
      await setSwitch("ai_restricted_content_enabled", false);

      // A failure is recorded and not retried at once (same input waits an hour). The system-log
      // slot is pre-claimed so this suite never writes a system_events row — the worker suites run
      // in parallel and the alert sweep's suite counts those rows.
      await pool.query(`update ai_integration set last_failure_logged_at = now()`);
      mode = "fail";
      await pool.query(`update challenges set title = 'Invoice matching subject, edited' where id = $1`, [subject.id]);
      const failed = await sweep();
      assert.equal(failed.failed, 1);
      assert.equal((await result(subject.id))?.status, "failed");
      assert.ok((await result(subject.id))?.payload, "the earlier note stays readable");
      assert.equal((await sweep()).ran, 0, "not retried at once");
      mode = "ok";

      // Nothing about the challenge changed.
      const { rows: ch } = await pool.query<{ status: string; assignee_id: string | null; visibility: string }>(`select status, assignee_id, visibility from challenges where id = $1`, [subject.id]);
      assert.deepEqual(ch[0], { status: "awaiting_triage", assignee_id: null, visibility: "org" });

      // Withdrawn → the note is deleted (by any sweep, even with the switch off).
      await pool.query(`update challenges set status = 'withdrawn' where id = $1`, [subject.id]);
      await setSwitch("ai_triage_assist_enabled", false);
      const cleaned = await sweep();
      assert.ok(cleaned.cleaned >= 1);
      assert.equal(await result(subject.id), undefined);
    } finally {
      await pool.query(`delete from ai_integration`).catch(() => {});
      await pool.query(`update platform_settings set value = 'false'::jsonb where key in ('ai_triage_assist_enabled', 'ai_restricted_content_enabled')`).catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await pool.end();
    }
  },
);

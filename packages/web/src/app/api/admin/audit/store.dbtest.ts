// Live-DB integration test (gated) for the §15 audit browser store: category chips, the
// cross-table search (action, target id, target number, actor name/e-mail — never the payload),
// the date range, paging in pages of 100, and the capped export. Self-skips when DATABASE_URL is
// unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "audit browser store: categories, search, date range, paging, export cap",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { appendAudit } = await import("../../../../lib/audit");
    const { exportAudit, listAudit } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: u } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name, email) values ($1, $2, $3, $4) returning id`,
        [`dbtest-audit-${stamp}`, `dbtest-audit-${stamp}@example.test`, `Dbtest Auditor ${stamp}`, `auditor-${stamp}@example.test`],
      );
      const actorId = u[0]!.id;
      // A real challenge so the target-number search has something to resolve.
      const { rows: ns } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active limit 1`);
      const { rows: ch } = await pool.query<{ id: string; number: number }>(
        `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
         values ($1, 'org', $2, 'audit browser dbtest', $3, $4, 'awaiting_triage') returning id, number`,
        [ns[0]!.id, `Audit browser dbtest ${stamp}`, ia[0]!.id, actorId],
      );
      const challengeId = ch[0]!.id;
      const challengeNumber = `CH-${ch[0]!.number}`;

      const marker = `dbtest-${stamp}`;
      await appendAudit(pool, { actorUserId: actorId, action: "challenge.status_changed", targetType: "challenge", targetId: challengeId, after: { marker, to: "valid" } });
      await appendAudit(pool, { actorUserId: actorId, action: "comment.posted", targetType: "comment", targetId: `comment-${marker}`, after: { marker } });
      await appendAudit(pool, { actorUserId: actorId, action: "scim.user_created", targetType: "user", targetId: `user-${marker}` });
      await appendAudit(pool, { actorUserId: actorId, action: "system_log.exported", targetType: "system_log", after: { marker } });

      const mine = { actorUserId: actorId };
      const all = await listAudit(pool, mine);
      assert.equal(all.total, 4);
      assert.equal(all.rows[0]!.action, "system_log.exported", "newest first");
      assert.equal(all.rows[0]!.actorEmail, `auditor-${stamp}@example.test`);
      const status = all.rows.find((r) => r.action === "challenge.status_changed")!;
      assert.equal(status.targetNumber, challengeNumber, "challenge targets resolve to their display number");
      assert.equal(all.rows.find((r) => r.action === "comment.posted")!.targetNumber, null);

      // Category chips by prefix.
      assert.deepEqual((await listAudit(pool, { ...mine, category: "challenges" })).rows.map((r) => r.action), ["challenge.status_changed"]);
      assert.deepEqual((await listAudit(pool, { ...mine, category: "comments" })).rows.map((r) => r.action), ["comment.posted"]);
      assert.deepEqual((await listAudit(pool, { ...mine, category: "identity" })).rows.map((r) => r.action), ["scim.user_created"]);
      assert.deepEqual((await listAudit(pool, { ...mine, category: "admin" })).rows.map((r) => r.action), ["system_log.exported"], "every *.exported lands under Admin");
      assert.equal((await listAudit(pool, { ...mine, category: "attachments" })).total, 0);

      // Search over the human-meaningful fields.
      assert.equal((await listAudit(pool, { ...mine, q: "status_chang" })).total, 1, "action");
      assert.equal((await listAudit(pool, { ...mine, q: challengeId })).total, 1, "target id");
      assert.equal((await listAudit(pool, { ...mine, q: challengeNumber })).total, 1, "target number");
      assert.equal((await listAudit(pool, { ...mine, q: `Auditor ${stamp}` })).total, 4, "actor name");
      assert.equal((await listAudit(pool, { ...mine, q: `auditor-${stamp}@example` })).total, 4, "actor e-mail");
      assert.equal((await listAudit(pool, { ...mine, q: marker })).total, 2, "target ids carrying the marker — the JSON payload is never searched");
      assert.equal((await listAudit(pool, { ...mine, q: `%${marker}` })).total, 0, "LIKE metacharacters are literal");

      // Date range (inclusive bounds).
      assert.equal((await listAudit(pool, { ...mine, from: new Date(Date.now() + 60_000).toISOString() })).total, 0);
      assert.equal((await listAudit(pool, { ...mine, to: new Date(Date.now() - 60_000).toISOString() })).total, 0);
      assert.equal((await listAudit(pool, { ...mine, from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() })).total, 4);

      // Paging.
      const p1 = await listAudit(pool, mine, { limit: 3, offset: 0 });
      assert.equal(p1.rows.length, 3);
      assert.equal(p1.hasMore, true);
      const p2 = await listAudit(pool, mine, { limit: 3, offset: 3 });
      assert.equal(p2.rows.length, 1);
      assert.equal(p2.hasMore, false);
      const p3 = await listAudit(pool, mine, { limit: 3, offset: 6 });
      assert.equal(p3.rows.length, 0);
      assert.equal(p3.total, 4, "an empty page past the end still reports the total");

      // Export: capped, newest-first, total still reported; before/after come through raw.
      const capped = await exportAudit(pool, mine, 2);
      assert.equal(capped.rows.length, 2);
      assert.equal(capped.totalMatching, 4);
      assert.equal(capped.rows[0]!.action, "system_log.exported");
      assert.deepEqual(capped.rows[0]!.after, { marker });
    } finally {
      await pool.end();
    }
  },
);

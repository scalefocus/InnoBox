// Live-DB integration test (gated) for the §12.4 webhook ENQUEUE side, driven through the real
// status-change store functions: first_valid_at pins challenge.validated to once per challenge;
// an implemented solution posts solution.implemented THEN challenge.solved (the §8.3 auto-close);
// an admin override into `solved` posts challenge.solved; the leak guard at enqueue keeps a
// namespace-restricted item out entirely; disabled webhooks and other namespaces get nothing;
// with WEBHOOK_ENC_KEY unset nothing is enqueued (but first_valid_at is still stamped); and the
// §10.3 delete cascade removes the subtree's delivery rows. Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "webhook enqueue: milestones, first-time validation, leak guard, routing, key gate, delete cascade",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID, randomBytes } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const { encryptWebhookUrl } = await import("@innobox/shared/webhook-send");
    const { setChallengeStatus, setSolutionStatus } = await import("../app/api/challenges/store");
    const { deleteChallenge } = await import("../app/api/challenges/delete");

    const savedKey = process.env.WEBHOOK_ENC_KEY;
    const keyB64 = randomBytes(32).toString("base64");
    process.env.WEBHOOK_ENC_KEY = keyB64;
    const key = Buffer.from(keyB64, "base64");

    const pool = new Pool({ connectionString: url });
    const storage = {
      putObject: async () => {},
      getObject: async () => new Uint8Array(),
      getObjectStream: async () => ({ body: new Blob([]).stream(), contentLength: 0 }),
      deleteObject: async () => {},
      createMultipartUpload: async () => "mpu-1",
      uploadPart: async () => {},
      listParts: async () => [],
      completeMultipartUpload: async () => {},
      abortMultipartUpload: async () => {},
    };
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const mkNs = async (label: string) =>
        (await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, $2) returning id`, [`dbtest-wh-${label}-${stamp}`, `Dbtest WH ${label}`])).rows[0]!.id;
      const nsId = await mkNs("a");
      const otherNsId = await mkNs("b");
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);
      const { rows: u } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
        [`dbtest-wh-admin-${stamp}`, `dbtest-wh-admin-${stamp}@example.test`, "Dbtest WH Admin"],
      );
      const adminId = u[0]!.id;
      const admin = { userId: adminId, roles: buildRoleSet([{ role: "platform_admin", namespaceId: null }], { globalNamespaceId: globalId }) };

      const mkHook = async (namespaceId: string, name: string, enabled = true) =>
        (
          await pool.query<{ id: string }>(
            `insert into channel_webhooks (namespace_id, name, format, url_enc, url_hint, enabled) values ($1, $2, 'json', $3, 'hooks.example.com …abcd', $4) returning id`,
            [namespaceId, name, encryptWebhookUrl("https://hooks.example.com/in/abcd", key), enabled],
          )
        ).rows[0]!.id;
      const hookA = await mkHook(nsId, "A");
      const hookA2 = await mkHook(nsId, "A2");
      await mkHook(nsId, "A-disabled", false);
      const hookOther = await mkHook(otherNsId, "Other");

      const mkChallenge = async (visibility: "org" | "namespace", status = "in_review") =>
        (
          await pool.query<{ id: string; number: number }>(
            `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
             values ($1, $2, $3, 'webhook enqueue', $4, $5, $6) returning id, number`,
            [nsId, visibility, `Webhook ${visibility} ${stamp}`, ia[0]!.id, adminId, status],
          )
        ).rows[0]!;
      const deliveries = async (entityId: string) =>
        (
          await pool.query<{ webhook_id: string; event: string; event_status: string; entity_type: string; status: string; attempts: number }>(
            `select webhook_id, event, event_status, entity_type, status, attempts from webhook_deliveries where entity_id = $1 order by created_at, webhook_id`,
            [entityId],
          )
        ).rows;
      const firstValidAt = async (id: string) =>
        (await pool.query<{ first_valid_at: Date | null }>(`select first_valid_at from challenges where id = $1`, [id])).rows[0]!.first_valid_at;

      // 1. An org-visible challenge entering `valid` the first time → one row per ENABLED webhook
      //    of its own namespace (never the disabled one, never another namespace's).
      const org = await mkChallenge("org");
      assert.equal(await firstValidAt(org.id), null);
      assert.equal((await setChallengeStatus(pool, admin, String(org.number), "valid")).status, "ok");
      assert.ok(await firstValidAt(org.id), "first transition into valid stamps first_valid_at");
      const v1 = await deliveries(org.id);
      assert.deepEqual(v1.map((d) => d.webhook_id).sort(), [hookA, hookA2].sort());
      assert.ok(v1.every((d) => d.event === "challenge.validated" && d.event_status === "valid" && d.status === "pending" && d.attempts === 0));
      assert.ok(!v1.some((d) => d.webhook_id === hookOther));
      const stampAt = (await firstValidAt(org.id))!.getTime();

      // 2. Leaving `valid` and returning never posts challenge.validated again.
      await setChallengeStatus(pool, admin, String(org.number), "in_review");
      await setChallengeStatus(pool, admin, String(org.number), "valid");
      assert.equal((await deliveries(org.id)).length, 2, "no second challenge.validated");
      assert.equal((await firstValidAt(org.id))!.getTime(), stampAt, "first_valid_at is never moved");

      // 3. An implemented solution: solution.implemented THEN challenge.solved (auto-close), in order.
      const { rows: sol } = await pool.query<{ id: string; number: number }>(
        `insert into solutions (challenge_id, description, author_id, status) values ($1, 'a solution', $2, 'accepted_internally') returning id, number`,
        [org.id, adminId],
      );
      assert.equal((await setSolutionStatus(pool, admin, String(sol[0]!.number), "implemented")).status, "ok");
      const solRows = await deliveries(sol[0]!.id);
      assert.deepEqual(solRows.map((d) => [d.event, d.event_status, d.entity_type]), [
        ["solution.implemented", "implemented", "solution"],
        ["solution.implemented", "implemented", "solution"],
      ]);
      const chRows = await deliveries(org.id);
      assert.deepEqual(chRows.filter((d) => d.event === "challenge.solved").length, 2, "the auto-close posts challenge.solved per webhook");
      const { rows: order } = await pool.query<{ event: string }>(
        `select event from webhook_deliveries where webhook_id = $1 and (entity_id = $2 or entity_id = $3) and event <> 'challenge.validated' order by next_attempt_at, created_at`,
        [hookA, org.id, sol[0]!.id],
      );
      assert.deepEqual(order.map((r) => r.event), ["solution.implemented", "challenge.solved"], "sweep order follows enqueue order");

      // 4. Admin override straight into `solved` posts challenge.solved; a no-op does not.
      const direct = await mkChallenge("org", "valid");
      await setChallengeStatus(pool, admin, String(direct.number), "solved");
      assert.deepEqual((await deliveries(direct.id)).map((d) => d.event), ["challenge.solved", "challenge.solved"]);
      await setChallengeStatus(pool, admin, String(direct.number), "solved");
      assert.equal((await deliveries(direct.id)).length, 2, "an unchanged status is not a transition");

      // 5. Leak guard at enqueue: a namespace-restricted challenge never enqueues — and later
      //    becoming org-visible does not post retroactively.
      const restricted = await mkChallenge("namespace");
      await setChallengeStatus(pool, admin, String(restricted.number), "valid");
      assert.ok(await firstValidAt(restricted.id), "stamped regardless of visibility");
      assert.equal((await deliveries(restricted.id)).length, 0, "namespace-restricted → nothing enqueued");
      await pool.query(`update challenges set visibility = 'org' where id = $1`, [restricted.id]);
      await setChallengeStatus(pool, admin, String(restricted.number), "in_review");
      await setChallengeStatus(pool, admin, String(restricted.number), "valid");
      assert.equal((await deliveries(restricted.id)).length, 0, "never posted retroactively");
      // A solution under a restricted challenge is equally kept out.
      const restricted2 = await mkChallenge("namespace", "valid");
      const { rows: rsol } = await pool.query<{ id: string; number: number }>(
        `insert into solutions (challenge_id, description, author_id, status) values ($1, 'hidden', $2, 'accepted_internally') returning id, number`,
        [restricted2.id, adminId],
      );
      await setSolutionStatus(pool, admin, String(rsol[0]!.number), "implemented");
      assert.equal((await deliveries(rsol[0]!.id)).length, 0);
      assert.equal((await deliveries(restricted2.id)).length, 0);

      // 6. WEBHOOK_ENC_KEY unset → nothing enqueued, first_valid_at still stamped.
      delete process.env.WEBHOOK_ENC_KEY;
      const off = await mkChallenge("org");
      await setChallengeStatus(pool, admin, String(off.number), "valid");
      assert.ok(await firstValidAt(off.id));
      assert.equal((await deliveries(off.id)).length, 0, "webhooks off → no delivery rows");
      process.env.WEBHOOK_ENC_KEY = keyB64;

      // 7. The §10.3 delete cascade removes every delivery row of the subtree, and counts them.
      const before = (await deliveries(org.id)).length + (await deliveries(sol[0]!.id)).length;
      assert.equal(before, 6);
      const del = await deleteChallenge({ pool, storage }, admin, String(org.number), "dbtest cleanup");
      assert.equal(del.status, "ok");
      if (del.status === "ok") assert.equal(del.counts.webhookDeliveries, 6);
      assert.equal((await deliveries(org.id)).length + (await deliveries(sol[0]!.id)).length, 0, "no orphan deliveries");
    } finally {
      if (savedKey === undefined) delete process.env.WEBHOOK_ENC_KEY;
      else process.env.WEBHOOK_ENC_KEY = savedKey;
      await pool.end();
    }
  },
);

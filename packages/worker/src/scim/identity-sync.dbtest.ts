// Live-DB integration test (gated) for the worker's half of §14.10 identity sync diagnostics
// (INNOBOX_SPEC.md): every SCIM group write (create / replace / patch — even one that changes
// nothing else) sets groups.scim_synced, a reconciliation-style mirror row stays false until SCIM
// touches it, the 0027 backfill reads SCIM origin off the audit trail, and the throttled stamper
// writes platform_settings.scim_last_request_at once per window. Self-skips when DATABASE_URL is
// unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "identity sync: SCIM group writes set scim_synced; the last-request stamp is throttled",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const [{ Pool }, express, { default: request }, { createScimRouter }, { createScimLastRequestStamper }, fs, path, { fileURLToPath }, shared] =
      await Promise.all([
        import("pg"),
        import("express").then((m) => m.default),
        import("supertest"),
        import("./router.js"),
        import("./last-request.js"),
        import("node:fs"),
        import("node:path"),
        import("node:url"),
        import("@innobox/shared"),
      ]);
    const { appendAudit, SCIM_LAST_REQUEST_AT_KEY } = shared;

    const pool = new Pool({ connectionString: url });
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const PREFIX = `idsync-${stamp}-`;
    const bearerToken = "idsync-bearer-5c1e0f7a9b2d4e68"; // gitleaks:allow — test-only fixture
    const app = express();
    app.use("/scim/v2", createScimRouter(pool, { bearerToken }));
    const auth = (req: import("supertest").Test) => req.set("Authorization", `Bearer ${bearerToken}`);
    const synced = async (id: string) =>
      (await pool.query<{ scim_synced: boolean }>(`select scim_synced from groups where id = $1`, [id])).rows[0]!.scim_synced;
    const mirror = async (suffix: string) =>
      // The reconciliation mirror's exact insert (recon/reconcile.ts) — no scim_synced column.
      (
        await pool.query<{ id: string }>(
          `insert into groups (external_id, display_name) values ($1, $2)
             on conflict (external_id) do update set display_name = excluded.display_name, updated_at = now()
           returning id`,
          [`${PREFIX}${suffix}`, `Mirror ${suffix}`],
        )
      ).rows[0]!.id;

    try {
      // ── POST creates a SCIM-provisioned group ────────────────────────────────────────
      const created = await auth(request(app).post("/scim/v2/Groups")).send({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        externalId: `${PREFIX}posted`,
        displayName: "Posted",
      });
      assert.equal(created.status, 201);
      assert.equal(await synced(created.body.id), true, "SCIM create sets scim_synced");

      // ── a reconciliation mirror stays false … ───────────────────────────────────────
      const mirroredPost = await mirror("mirror-post");
      assert.equal(await synced(mirroredPost), false, "reconciliation's mirror leaves scim_synced false");
      // … until a replayed SCIM POST with nothing to change touches it.
      const replay = await auth(request(app).post("/scim/v2/Groups")).send({ externalId: `${PREFIX}mirror-post`, displayName: "Mirror mirror-post" });
      assert.equal(replay.status, 200);
      assert.equal(await synced(mirroredPost), true, "an idempotent SCIM POST still counts as a SCIM write");

      // ── PATCH with a membership-only change (no rename) ──────────────────────────────
      const mirroredPatch = await mirror("mirror-patch");
      const patched = await auth(request(app).patch(`/scim/v2/Groups/${mirroredPatch}`)).send({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "Remove", path: "members" }],
      });
      assert.equal(patched.status, 200);
      assert.equal(await synced(mirroredPatch), true, "SCIM PATCH sets scim_synced");

      // ── PUT ────────────────────────────────────────────────────────────────────────
      const mirroredPut = await mirror("mirror-put");
      const put = await auth(request(app).put(`/scim/v2/Groups/${mirroredPut}`)).send({ displayName: "Renamed by PUT", members: [] });
      assert.equal(put.status, 200);
      assert.equal(await synced(mirroredPut), true, "SCIM PUT sets scim_synced");

      // ── reconciliation's upsert never clears it ──────────────────────────────────────
      await mirror("posted");
      assert.equal(await synced(created.body.id), true, "the reconciliation upsert leaves a SCIM group SCIM-provisioned");

      // ── the 0027 backfill: SCIM origin read off the audit trail ──────────────────────
      const scimOrigin = await mirror("bf-scim");
      const reconOrigin = await mirror("bf-recon");
      const renamedLater = await mirror("bf-renamed");
      await appendAudit(pool, { actorUserId: null, action: "scim.group_created", targetType: "group", targetId: scimOrigin, after: { externalId: `${PREFIX}bf-scim` } });
      await appendAudit(pool, {
        actorUserId: null,
        action: "scim.group_created",
        targetType: "group",
        targetId: reconOrigin,
        after: { externalId: `${PREFIX}bf-recon`, via: "reconciliation" },
      });
      await appendAudit(pool, { actorUserId: null, action: "scim.group_created", targetType: "group", targetId: renamedLater, after: { via: "reconciliation" } });
      await appendAudit(pool, { actorUserId: null, action: "scim.group_renamed", targetType: "group", targetId: renamedLater, after: { displayName: "x" } });
      // The migration's UPDATE (its ALTER needs the owner; the app role holds UPDATE on groups).
      const here = path.dirname(fileURLToPath(import.meta.url));
      const migration = fs.readFileSync(path.resolve(here, "../../../../db/migrations/0027_identity_sync.sql"), "utf8");
      const backfill = migration.slice(migration.indexOf("UPDATE groups"));
      assert.ok(backfill.startsWith("UPDATE groups"), "the backfill statement is found");
      await pool.query(backfill);
      assert.equal(await synced(scimOrigin), true, "a SCIM-origin create audit row backfills true");
      assert.equal(await synced(reconOrigin), false, "a via: reconciliation create stays false");
      assert.equal(await synced(renamedLater), true, "a later SCIM rename counts as a SCIM write");

      // ── the throttled stamp ───────────────────────────────────────────────────────────
      let now = Date.parse("2026-10-08T09:00:00Z");
      const stamper = createScimLastRequestStamper(pool, { now: () => now });
      const read = async () =>
        (await pool.query<{ value: unknown }>(`select value from platform_settings where key = $1`, [SCIM_LAST_REQUEST_AT_KEY])).rows[0]?.value;
      const settle = async (expected: string) => {
        for (let i = 0; i < 50 && (await read()) !== expected; i++) await new Promise((r) => setTimeout(r, 20));
      };
      stamper();
      await settle("2026-10-08T09:00:00.000Z");
      assert.equal(await read(), "2026-10-08T09:00:00.000Z");
      now += 30_000;
      stamper(); // inside the window — dropped
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(await read(), "2026-10-08T09:00:00.000Z", "a second request within 60 s does not write");
      now += 30_000;
      stamper();
      await settle("2026-10-08T09:01:00.000Z");
      assert.equal(await read(), "2026-10-08T09:01:00.000Z", "the next window writes again");

      // A SCIM request through the router stamps via onAccepted; a 401 does not.
      let accepted = 0;
      const stampedApp = express();
      stampedApp.use("/scim/v2", createScimRouter(pool, { bearerToken, onAccepted: () => (accepted += 1) }));
      await request(stampedApp).get("/scim/v2/Groups");
      await auth(request(stampedApp).get(`/scim/v2/Groups?filter=${encodeURIComponent(`externalId eq "${PREFIX}posted"`)}`));
      assert.equal(accepted, 1);
    } finally {
      await pool.query(`delete from groups where external_id like $1`, [`${PREFIX}%`]);
      await pool.end();
    }
  },
);

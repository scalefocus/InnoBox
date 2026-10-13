// Live-DB integration test (gated) for the §25.3 leaver rule (INNOBOX_SPEC.md): when SCIM
// deactivates a person — PATCH active=false or DELETE /Users — every AI agent grant they hold is
// revoked (audited `mcp.grant_revoked`, reason "deactivated") and every token under it deleted, in
// the deactivation's own transaction; a reactivated person gets nothing back. Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";

const url = process.env.DATABASE_URL;

test(
  "SCIM deactivation revokes every AI agent grant and token with it",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const [{ Pool }, express, { default: request }, { createScimRouter }] = await Promise.all([
      import("pg"),
      import("express").then((m) => m.default),
      import("supertest"),
      import("./router.js"),
    ]);
    const pool = new Pool({ connectionString: url });
    const bearerToken = "scimtest-bearer-agents-5c1e"; // gitleaks:allow — test-only fixture
    const app = express();
    app.use("/scim/v2", createScimRouter(pool, { bearerToken }));
    const auth = (req: import("supertest").Test) => req.set("Authorization", `Bearer ${bearerToken}`);
    const runId = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;

    const provision = async (label: string): Promise<string> => {
      const userName = `scimtest-${runId}-${label}@example.com`;
      const res = await auth(
        request(app)
          .post("/scim/v2/Users")
          .send({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], externalId: `scimtest-${runId}-${label}`, userName, active: true, displayName: `Agent ${label}` }),
      );
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body.id as string;
    };
    const connect = async (userId: string): Promise<string> => {
      const { rows: c } = await pool.query<{ id: string }>(
        `insert into oauth_clients (client_id, client_name, redirect_uris) values ($1, 'SCIM test agent', array['http://127.0.0.1:1/cb']) returning id`,
        [`scimtest-${randomUUID()}`],
      );
      const { rows: g } = await pool.query<{ id: string }>(`insert into oauth_grants (user_id, client_id) values ($1, $2) returning id`, [userId, c[0]!.id]);
      await pool.query(`insert into oauth_tokens (grant_id, kind, token_hash, expires_at) values ($1, 'access', $2, now() + interval '1 hour')`, [
        g[0]!.id,
        createHash("sha256").update(randomUUID()).digest("hex"),
      ]);
      return g[0]!.id;
    };
    const state = async (grantId: string) => {
      const { rows } = await pool.query<{ revoked: boolean; tokens: number }>(
        `select revoked_at is not null as revoked, (select count(*)::int from oauth_tokens where grant_id = $1) as tokens from oauth_grants where id = $1`,
        [grantId],
      );
      return rows[0]!;
    };
    const reasons = async (grantId: string) =>
      (await pool.query<{ reason: string }>(`select after->>'reason' as reason from audit_log where action = 'mcp.grant_revoked' and target_id = $1`, [grantId])).rows.map((r) => r.reason);

    try {
      // PATCH active=false (Entra's soft-delete).
      const patched = await provision("patch");
      const g1 = await connect(patched);
      const off = await auth(
        request(app)
          .patch(`/scim/v2/Users/${patched}`)
          .send({ schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "Replace", path: "active", value: false }] }),
      );
      assert.equal(off.status, 200, JSON.stringify(off.body));
      assert.deepEqual(await state(g1), { revoked: true, tokens: 0 });
      assert.deepEqual(await reasons(g1), ["deactivated"]);
      // Reactivation restores nothing: the person connects again.
      const on = await auth(
        request(app)
          .patch(`/scim/v2/Users/${patched}`)
          .send({ schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "Replace", path: "active", value: true }] }),
      );
      assert.equal(on.status, 200);
      assert.deepEqual(await state(g1), { revoked: true, tokens: 0 });

      // DELETE /Users (hard leaver → deactivate).
      const deleted = await provision("delete");
      const g2 = await connect(deleted);
      assert.equal((await auth(request(app).delete(`/scim/v2/Users/${deleted}`))).status, 204);
      assert.deepEqual(await state(g2), { revoked: true, tokens: 0 });
      assert.deepEqual(await reasons(g2), ["deactivated"]);

      // An attribute update leaves the grant alone.
      const kept = await provision("kept");
      const g3 = await connect(kept);
      const renamed = await auth(
        request(app)
          .patch(`/scim/v2/Users/${kept}`)
          .send({ schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "Replace", path: "displayName", value: "Renamed" }] }),
      );
      assert.equal(renamed.status, 200);
      assert.deepEqual(await state(g3), { revoked: false, tokens: 1 });
    } finally {
      await pool.end();
    }
  },
);

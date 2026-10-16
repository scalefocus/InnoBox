// Hermetic router tests (ENTRA_AUTH_SPEC.md §5 layer 2) against a fake pool: a malformed `{id}` is
// a 404 on every id-addressed verb WITHOUT reaching the database, and a unique-index violation
// that slips past the explicit checks answers 409 `uniqueness`, never 500, an unknown path is a
// SCIM-shaped 404 (never Express's HTML page), and a used, active row keeps its externalId (409
// `mutability`, nothing written). The live-DB walk is scim.dbtest.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import type { Pool } from "pg";
import { createScimRouter, isScimId } from "./router.js";

const bearerToken = "router-unit-bearer-3e9a7c1d5b2f4086"; // gitleaks:allow — test-only fixture
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

function appWith(query: (text: string, values?: unknown[]) => Promise<unknown>) {
  const app = express();
  app.use("/scim/v2", createScimRouter({ query } as unknown as Pool, { bearerToken }));
  return app;
}

test("isScimId: only a well-formed uuid names a resource", () => {
  assert.equal(isScimId("2f1d0c9b-8a7e-4d6c-b5a4-3e2f1d0c9b8a"), true);
  assert.equal(isScimId("2F1D0C9B-8A7E-4D6C-B5A4-3E2F1D0C9B8A"), true);
  for (const bad of [undefined, "", "not-a-uuid", "12345", "2f1d0c9b-8a7e-4d6c-b5a4-3e2f1d0c9b8", "2f1d0c9b8a7e4d6cb5a43e2f1d0c9b8a"]) {
    assert.equal(isScimId(bad), false, JSON.stringify(bad));
  }
});

test("malformed {id}: 404 on GET/PUT/PATCH/DELETE for Users and Groups, no database round-trip", async () => {
  let queries = 0;
  const app = appWith(async () => {
    queries += 1;
    throw new Error("the database must not be reached for a malformed id");
  });
  const body = { Operations: [{ op: "replace", path: "active", value: false }] };
  for (const resource of ["Users", "Groups"]) {
    for (const method of ["get", "put", "patch", "delete"] as const) {
      const res = await request(app)
        [method](`/scim/v2/${resource}/not-a-uuid`)
        .set("Authorization", `Bearer ${bearerToken}`)
        .send(method === "get" || method === "delete" ? undefined : body);
      assert.equal(res.status, 404, `${method.toUpperCase()} /${resource}/not-a-uuid`);
      assert.equal(res.body.schemas?.[0], ERROR_SCHEMA);
    }
  }
  assert.equal(queries, 0);
});

test("unique-index violation (23505) that slips past the explicit checks → 409 uniqueness", async () => {
  const app = appWith(async () => {
    throw Object.assign(new Error('duplicate key value violates unique constraint "users_user_name_lower_idx"'), {
      code: "23505",
    });
  });
  const res = await request(app)
    .post("/scim/v2/Users")
    .set("Authorization", `Bearer ${bearerToken}`)
    .send({ externalId: "oid-1", userName: "ada@example.com" });
  assert.equal(res.status, 409);
  assert.equal(res.body.scimType, "uniqueness");
  assert.ok(!JSON.stringify(res.body).includes("users_user_name_lower_idx"), "the constraint name is not leaked");
});

test("any other database failure is still a SCIM-shaped 500", async () => {
  const app = appWith(async () => {
    throw Object.assign(new Error("connection terminated"), { code: "57P01" });
  });
  const res = await request(app)
    .get("/scim/v2/Users/2f1d0c9b-8a7e-4d6c-b5a4-3e2f1d0c9b8a")
    .set("Authorization", `Bearer ${bearerToken}`);
  assert.equal(res.status, 500);
  assert.equal(res.body.schemas?.[0], ERROR_SCHEMA);
});

test("unknown path: an authenticated request gets a SCIM 404 envelope, never Express's HTML page; unauthenticated stays 401", async () => {
  let queries = 0;
  const app = appWith(async () => {
    queries += 1;
    throw new Error("the database must not be reached for an unknown path");
  });
  for (const [method, path] of [
    ["get", "/scim/v2/Nope"],
    ["post", "/scim/v2/Users/2f1d0c9b-8a7e-4d6c-b5a4-3e2f1d0c9b8a/extra"],
    ["get", "/scim/v2/"],
    ["put", "/scim/v2/Bulk"],
  ] as const) {
    const res = await request(app)[method](path).set("Authorization", `Bearer ${bearerToken}`);
    assert.equal(res.status, 404, `${method.toUpperCase()} ${path}`);
    assert.match(res.headers["content-type"] ?? "", /json/, "a JSON body, never text/html");
    assert.deepEqual(res.body, { schemas: [ERROR_SCHEMA], status: "404", detail: "Resource not found" });
    assert.equal(res.text.includes("<"), false, "no HTML");
  }
  assert.equal(queries, 0);

  const unauth = await request(app).get("/scim/v2/Nope");
  assert.equal(unauth.status, 401, "the bearer check still runs first on an unknown path");
  assert.equal(unauth.body.schemas?.[0], ERROR_SCHEMA);
});

// ── ENTRA_AUTH_SPEC.md §5 (v1.16): externalId is immutable on a row that has signed in and is active ──

const ROW_ID = "2f1d0c9b-8a7e-4d6c-b5a4-3e2f1d0c9b8a";

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ROW_ID,
    external_id: "oid-original",
    user_name: "ada@example.com",
    email: "ada@example.com",
    display_name: "Ada",
    department: null,
    job_title: null,
    active: true,
    deactivated_at: null,
    scrubbed_at: null,
    last_seen_at: new Date("2026-10-01T00:00:00Z"),
    created_at: new Date("2026-09-01T00:00:00Z"),
    updated_at: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

/** A fake pool that serves `row` for the id lookup, answers the uniqueness probes with "free",
 *  records every `update users` and every audit insert, and never reaches a real database. */
function rowPool(row: Record<string, unknown>) {
  const updates: unknown[][] = [];
  const audits: string[] = [];
  const query = async (text: string, values?: unknown[]) => {
    if (/select \* from users where id/i.test(text)) return { rows: [row], rowCount: 1 };
    if (/select \* from users where/i.test(text)) return { rows: [], rowCount: 0 };
    if (/insert into audit_log/i.test(text)) {
      audits.push(JSON.stringify(values));
      return { rows: [], rowCount: 1 };
    }
    if (/^\s*update users/i.test(text)) {
      updates.push(values ?? []);
      // updateUserPatch binds externalId last; updateUserFull binds it second.
      const ext = /set external_id = \$2/i.test(text) ? values?.[1] : values?.[values.length - 1];
      return { rows: [{ ...row, external_id: ext }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 }; // BEGIN/COMMIT, bindPendingAccess, revokeUserGrants
  };
  const client = { query, release() {} };
  return { pool: { query, connect: async () => client } as unknown as Pool, updates, audits };
}

test("externalId change on a used, active row → 409 mutability, nothing written, scim.anomaly audited (PATCH and PUT)", async () => {
  for (const method of ["patch", "put"] as const) {
    const { pool, updates, audits } = rowPool(userRow());
    const app = express();
    app.use("/scim/v2", createScimRouter(pool, { bearerToken }));
    const body =
      method === "patch"
        ? { Operations: [{ op: "Replace", path: "externalId", value: "oid-hijacked" }] }
        : { externalId: "oid-hijacked", userName: "ada@example.com", displayName: "Ada", active: true };
    const res = await request(app)[method](`/scim/v2/Users/${ROW_ID}`).set("Authorization", `Bearer ${bearerToken}`).send(body);
    assert.equal(res.status, 409, `${method.toUpperCase()}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.scimType, "mutability");
    assert.equal(res.body.schemas?.[0], ERROR_SCHEMA);
    assert.equal(updates.length, 0, `${method.toUpperCase()} wrote nothing`);
    assert.equal(audits.length, 1, `${method.toUpperCase()} audited exactly one row`);
    const audit = audits[0]!;
    assert.ok(audit.includes("scim.anomaly"), audit);
    assert.ok(audit.includes("external_id_immutable"), audit);
    assert.ok(audit.includes(`${method.toUpperCase()} /Users/:id`), audit);
  }
});

test("a same-value externalId on a used, active row is not a change: the write goes through", async () => {
  const { pool, updates, audits } = rowPool(userRow());
  const app = express();
  app.use("/scim/v2", createScimRouter(pool, { bearerToken }));
  const res = await request(app)
    .put(`/scim/v2/Users/${ROW_ID}`)
    .set("Authorization", `Bearer ${bearerToken}`)
    .send({ externalId: "oid-original", userName: "ada@example.com", displayName: "Ada Lovelace", active: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(updates.length, 1);
  assert.equal(audits.some((a) => a.includes("external_id_immutable")), false);
});

test("externalId change is still allowed on a never-used row and on an inactive row", async () => {
  for (const [label, row] of [
    ["never used", userRow({ last_seen_at: null })],
    ["inactive", userRow({ active: false, deactivated_at: new Date("2026-10-02T00:00:00Z") })],
  ] as const) {
    const { pool, updates, audits } = rowPool(row);
    const app = express();
    app.use("/scim/v2", createScimRouter(pool, { bearerToken }));
    const res = await request(app)
      .patch(`/scim/v2/Users/${ROW_ID}`)
      .set("Authorization", `Bearer ${bearerToken}`)
      .send({ Operations: [{ op: "Replace", path: "externalId", value: "oid-rekeyed" }] });
    assert.equal(res.status, 200, `${label}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.externalId, "oid-rekeyed", label);
    assert.equal(updates.length, 1, `${label}: the row was re-keyed`);
    assert.equal(audits.some((a) => a.includes("external_id_immutable")), false, `${label}: no anomaly for a permitted re-key`);
  }
});

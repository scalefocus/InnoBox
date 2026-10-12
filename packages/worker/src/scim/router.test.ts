// Hermetic router tests (ENTRA_AUTH_SPEC.md §5 layer 2) against a fake pool: a malformed `{id}` is
// a 404 on every id-addressed verb WITHOUT reaching the database, and a unique-index violation
// that slips past the explicit checks answers 409 `uniqueness`, never 500. The live-DB walk is
// scim.dbtest.ts.
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

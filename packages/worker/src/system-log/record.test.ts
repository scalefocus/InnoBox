// Unit tests for the worker's SCIM system-log observer (INNOBOX_SPEC.md §14.7): only 401/403 are
// recorded, the query string is dropped, the SCIM response is untouched, and a failing recorder
// is swallowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import type { Pool } from "pg";
import type { SystemEventInput } from "@innobox/shared";
import { SCIM_ROUTE_TEMPLATE, createScimEventRecorder, scimStatusRecorded } from "./record.js";
import { systemErrorMessage } from "./alert.js";

function buildApp(record: (pool: Pool, e: SystemEventInput) => Promise<void>) {
  const app = express();
  app.use("/scim/v2", createScimEventRecorder({} as Pool, record));
  app.get("/scim/v2/Users", (req, res) => {
    const auth = req.header("authorization");
    if (!auth) return res.status(401).json({ detail: "no token" });
    if (auth === "Bearer forbidden") return res.status(403).json({ detail: "forbidden" });
    if (auth === "Bearer missing") return res.status(404).json({ detail: "missing" });
    return res.json({ Resources: [] });
  });
  return app;
}

test("scimStatusRecorded: only the auth carve-out", () => {
  assert.equal(scimStatusRecorded(401), true);
  assert.equal(scimStatusRecorded(403), true);
  for (const s of [200, 400, 404, 409, 429, 500]) assert.equal(scimStatusRecorded(s), false, String(s));
});

test("a 401 and a 403 are recorded without the query string; 200 and 404 are not", async () => {
  const recorded: SystemEventInput[] = [];
  const app = buildApp(async (_pool, e) => {
    recorded.push(e);
  });
  await request(app).get("/scim/v2/Users?filter=userName%20eq%20%22x%22").expect(401);
  await request(app).get("/scim/v2/Users").set("authorization", "Bearer forbidden").expect(403);
  await request(app).get("/scim/v2/Users").set("authorization", "Bearer ok").expect(200);
  await request(app).get("/scim/v2/Users").set("authorization", "Bearer missing").expect(404);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(recorded.map((e) => e.status), [401, 403]);
  assert.equal(recorded[0]!.path, "/scim/v2/Users", "the filter query string is never stored");
  assert.equal(recorded[0]!.route, SCIM_ROUTE_TEMPLATE);
  assert.equal(recorded[0]!.source, "worker");
  assert.equal(recorded[0]!.errorCode, "scim_unauthorized");
  assert.equal(recorded[1]!.errorCode, "scim_forbidden");
  assert.equal(recorded[0]!.userId, undefined, "no person is behind a provisioning call");
});

test("a failing recorder never changes the SCIM response", async () => {
  const app = buildApp(async () => {
    throw new Error("db down");
  });
  const res = await request(app).get("/scim/v2/Users").expect(401);
  assert.deepEqual(res.body, { detail: "no token" });
});

test("the alert message reads naturally for one and many", () => {
  assert.equal(systemErrorMessage(1), "1 new system log event needs a look.");
  assert.equal(systemErrorMessage(4), "4 new system log events need a look.");
});

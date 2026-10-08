// §14.10 (INNOBOX_SPEC.md): the scim_last_request_at stamp — throttled to one write per 60 s per
// process, fire-and-forget (a failing write never surfaces), and fired only for requests that
// passed the bearer-token check.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import type { Pool } from "pg";
import { createScimLastRequestStamper } from "./last-request.js";
import { createScimRouter } from "./router.js";

const fakePool = {} as Pool;

test("stamper: first call writes, calls within 60 s are dropped, the next window writes again", () => {
  let now = Date.parse("2026-10-08T10:00:00Z");
  const writes: string[] = [];
  const stamp = createScimLastRequestStamper(fakePool, {
    now: () => now,
    write: async (_pool, at) => {
      writes.push(at.toISOString());
    },
  });
  stamp();
  now += 1_000;
  stamp();
  now += 58_998; // 59.998 s after the first write — still inside the window
  stamp();
  assert.deepEqual(writes, ["2026-10-08T10:00:00.000Z"]);
  now += 2; // exactly 60 s after the first
  stamp();
  assert.deepEqual(writes, ["2026-10-08T10:00:00.000Z", "2026-10-08T10:01:00.000Z"]);
});

test("stamper: a failing write (rejected or thrown) never escapes, and still counts toward the window", async () => {
  let now = 0;
  let calls = 0;
  const rejecting = createScimLastRequestStamper(fakePool, {
    now: () => now,
    write: async () => {
      calls += 1;
      throw new Error("db down");
    },
  });
  assert.doesNotThrow(() => rejecting());
  now = 10_000;
  rejecting();
  assert.equal(calls, 1, "a failed attempt does not reopen the window early");

  const throwing = createScimLastRequestStamper(fakePool, {
    write: () => {
      throw new Error("sync throw");
    },
  });
  assert.doesNotThrow(() => throwing());
  await new Promise((r) => setImmediate(r)); // no unhandled rejection surfaces
});

test("router: onAccepted fires for bearer-accepted requests only (any outcome), never for a 401", async () => {
  const token = "scim-unit-bearer-0123456789abcdef"; // gitleaks:allow — test-only fixture
  let accepted = 0;
  const app = express();
  app.use("/scim/v2", createScimRouter(fakePool, { bearerToken: token, onAccepted: () => (accepted += 1) }));

  const noAuth = await request(app).get("/scim/v2/ServiceProviderConfig");
  assert.equal(noAuth.status, 401);
  const wrong = await request(app).get("/scim/v2/ServiceProviderConfig").set("Authorization", "Bearer wrong");
  assert.equal(wrong.status, 401);
  assert.equal(accepted, 0, "rejected requests never stamp");

  const ok = await request(app).get("/scim/v2/ServiceProviderConfig").set("Authorization", `Bearer ${token}`);
  assert.equal(ok.status, 200);
  const notFound = await request(app).get("/scim/v2/Schemas/urn:nope").set("Authorization", `Bearer ${token}`);
  assert.equal(notFound.status, 404);
  assert.equal(accepted, 2, "an accepted request stamps whatever its outcome");
});

test("router: a throwing onAccepted never touches the SCIM response", async () => {
  const token = "scim-unit-bearer-0123456789abcdef"; // gitleaks:allow — test-only fixture
  const app = express();
  app.use(
    "/scim/v2",
    createScimRouter(fakePool, {
      bearerToken: token,
      onAccepted: () => {
        throw new Error("boom");
      },
    }),
  );
  const res = await request(app).get("/scim/v2/ResourceTypes").set("Authorization", `Bearer ${token}`);
  assert.equal(res.status, 200);
});

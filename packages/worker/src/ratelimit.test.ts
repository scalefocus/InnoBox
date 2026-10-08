// Unit tests for the worker's SCIM rate limiter (INNOBOX_SPEC.md §2): per-IP keying, the SCIM
// 429 envelope with Retry-After, exemption of the operational endpoints by mount, and the
// TRUST_PROXY parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { SlidingWindowLimiter } from "@innobox/shared";
import { createScimRateLimit, parseTrustProxy } from "./ratelimit.js";

function buildApp(max: number) {
  const app = express();
  app.set("trust proxy", true);
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.use("/scim/v2", createScimRateLimit({ rule: { max, windowMs: 60_000 }, limiter: new SlidingWindowLimiter(), multiplier: 1 }));
  app.get("/scim/v2/Users", (_req, res) => res.json({ Resources: [] }));
  return app;
}

test("SCIM requests beyond the budget get a 429 in the SCIM envelope with Retry-After", async () => {
  const app = buildApp(2);
  await request(app).get("/scim/v2/Users").expect(200);
  await request(app).get("/scim/v2/Users").expect(200);
  const res = await request(app).get("/scim/v2/Users").expect(429);
  assert.equal(res.headers["retry-after"], "60");
  assert.deepEqual(res.body.schemas, ["urn:ietf:params:scim:api:messages:2.0:Error"]);
  assert.equal(res.body.status, "429");
});

test("the limiter keys on the forwarded client IP, so one noisy client never throttles another", async () => {
  const app = buildApp(1);
  await request(app).get("/scim/v2/Users").set("X-Forwarded-For", "10.0.0.1").expect(200);
  await request(app).get("/scim/v2/Users").set("X-Forwarded-For", "10.0.0.1").expect(429);
  await request(app).get("/scim/v2/Users").set("X-Forwarded-For", "10.0.0.2").expect(200);
});

test("the operational endpoints are never throttled — the limiter is mounted on SCIM only", async () => {
  const app = buildApp(1);
  await request(app).get("/scim/v2/Users").expect(200);
  await request(app).get("/scim/v2/Users").expect(429);
  for (let i = 0; i < 5; i++) await request(app).get("/healthz").expect(200);
});

test("the multiplier scales the SCIM budget", async () => {
  const app = express();
  app.use("/scim/v2", createScimRateLimit({ rule: { max: 1, windowMs: 60_000 }, limiter: new SlidingWindowLimiter(), multiplier: 3 }));
  app.get("/scim/v2/Users", (_req, res) => res.json({}));
  for (let i = 0; i < 3; i++) await request(app).get("/scim/v2/Users").expect(200);
  await request(app).get("/scim/v2/Users").expect(429);
});

test("parseTrustProxy covers the documented forms", () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy(""), false);
  assert.equal(parseTrustProxy("true"), true);
  assert.equal(parseTrustProxy("false"), false);
  assert.equal(parseTrustProxy("1"), 1);
  assert.equal(parseTrustProxy("2"), 2);
  assert.equal(parseTrustProxy("loopback"), "loopback");
  assert.equal(parseTrustProxy("10.0.0.0/8, 172.16.0.0/12"), "10.0.0.0/8, 172.16.0.0/12");
});

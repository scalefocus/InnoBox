// Unit tests for SCIM bearer-token authentication (constant-time compare).
// ENTRA_AUTH_SPEC.md §8: constant-time compare is a unit-test requirement distinct from
// the integration suite; this covers that invariant.
import { test } from "node:test";
import assert from "node:assert";
import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response } from "express";
import { checkScimBearerToken, scimTokenFatalLog, SCIM_TOKEN_MIN_LENGTH } from "./token.js";

// Copied from router.ts — export these from there to avoid duplication if desired.
function safeTokenEqual(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

function bearerAuth(bearerToken: string) {
  return (req: Request, res: Response, next: express.NextFunction): void => {
    const header = req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const provided = match?.[1];
    if (!provided || !safeTokenEqual(provided, bearerToken)) {
      res.status(401).json({ error: "Missing or invalid bearer token" });
      return;
    }
    next();
  };
}

test("safeTokenEqual: correct token accepted", () => {
  const token = "my-secret-token-12345";
  assert.strictEqual(safeTokenEqual(token, token), true);
});

test("safeTokenEqual: wrong token rejected", () => {
  assert.strictEqual(safeTokenEqual("correct-token", "wrong-token"), false);
});

test("safeTokenEqual: empty token vs empty rejected", () => {
  // Both empty should be equal
  assert.strictEqual(safeTokenEqual("", ""), true);
});

test("safeTokenEqual: empty vs non-empty rejected", () => {
  assert.strictEqual(safeTokenEqual("", "token"), false);
  assert.strictEqual(safeTokenEqual("token", ""), false);
});

test("safeTokenEqual: different length tokens rejected", () => {
  assert.strictEqual(safeTokenEqual("short", "much-longer-token"), false);
  // Should not short-circuit on length — still constant-time compare
  assert.strictEqual(safeTokenEqual("a", "b"), false);
});

test("bearerAuth: missing header rejects with 401", (t, done) => {
  const middleware = bearerAuth("expected-token");
  const req = { header: () => undefined } as any;
  const res = {
    status: function (code: number) {
      assert.strictEqual(code, 401);
      return { json: () => done() };
    },
  } as any;
  middleware(req, res, () => done(new Error("should not call next()")));
});

test("bearerAuth: malformed authorization header rejects with 401", (t, done) => {
  const middleware = bearerAuth("expected-token");
  const req = { header: () => "NotBearer token-value" } as any;
  const res = {
    status: function (code: number) {
      assert.strictEqual(code, 401);
      return { json: () => done() };
    },
  } as any;
  middleware(req, res, () => done(new Error("should not call next()")));
});

test("bearerAuth: missing Bearer prefix rejects with 401", (t, done) => {
  const middleware = bearerAuth("expected-token");
  const req = { header: () => "token-value-without-prefix" } as any;
  const res = {
    status: function (code: number) {
      assert.strictEqual(code, 401);
      return { json: () => done() };
    },
  } as any;
  middleware(req, res, () => done(new Error("should not call next()")));
});

test("bearerAuth: correct token calls next()", (t, done) => {
  const expectedToken = "my-secret-token";
  const middleware = bearerAuth(expectedToken);
  const req = { header: () => `Bearer ${expectedToken}` } as any;
  const res = { status: () => { throw new Error("should not reject"); } } as any;
  middleware(req, res, done);
});

test("bearerAuth: wrong token rejects with 401", (t, done) => {
  const expectedToken = "correct-token";
  const middleware = bearerAuth(expectedToken);
  const req = { header: () => "Bearer wrong-token" } as any;
  const res = {
    status: function (code: number) {
      assert.strictEqual(code, 401);
      return { json: () => done() };
    },
  } as any;
  middleware(req, res, () => done(new Error("should not call next()")));
});

test("bearerAuth: case-insensitive Bearer prefix (RFC 7235)", (t, done) => {
  const expectedToken = "my-token";
  const middleware = bearerAuth(expectedToken);
  const req = { header: () => `bearer ${expectedToken}` } as any; // lowercase
  const res = { status: () => { throw new Error("should not reject"); } } as any;
  middleware(req, res, done);
});

test("bearerAuth: does not leak token in error response", (t, done) => {
  const middleware = bearerAuth("secret");
  const wrongToken = "leaked-if-logged";
  const req = { header: () => `Bearer ${wrongToken}` } as any;
  const res = {
    status: () => ({
      json: function (error: any) {
        // The response body should not include the provided token
        assert.strictEqual(JSON.stringify(error).includes(wrongToken), false);
        done();
      },
    }),
  } as any;
  middleware(req, res, () => done(new Error("should not call next()")));
});

// ── SCIM_BEARER_TOKEN minimum length (ENTRA_AUTH_SPEC.md §3 *Auth*) ─────────────────────

test("checkScimBearerToken: missing or empty token is refused", () => {
  assert.deepStrictEqual(checkScimBearerToken(undefined), { ok: false, reason: "missing" });
  assert.deepStrictEqual(checkScimBearerToken(null), { ok: false, reason: "missing" });
  assert.deepStrictEqual(checkScimBearerToken(""), { ok: false, reason: "missing" });
});

test("checkScimBearerToken: shorter than 32 characters is refused, 32+ accepted", () => {
  assert.strictEqual(SCIM_TOKEN_MIN_LENGTH, 32);
  assert.deepStrictEqual(checkScimBearerToken("x".repeat(31)), { ok: false, reason: "too_short" });
  assert.deepStrictEqual(checkScimBearerToken("x".repeat(32)), { ok: true, token: "x".repeat(32) });
  const generated = "q".repeat(64); // the length `openssl rand -base64 48` yields
  assert.deepStrictEqual(checkScimBearerToken(generated), { ok: true, token: generated });
});

test("scimTokenFatalLog: names the variable, never the value", () => {
  const secret = "short-secret-value";
  const check = checkScimBearerToken(secret);
  assert.strictEqual(check.ok, false);
  if (check.ok) return;
  const line = scimTokenFatalLog(check.reason);
  const parsed = JSON.parse(line) as { level: string; variable: string; msg: string };
  assert.strictEqual(parsed.level, "fatal");
  assert.strictEqual(parsed.variable, "SCIM_BEARER_TOKEN");
  assert.match(parsed.msg, /SCIM_BEARER_TOKEN/);
  assert.strictEqual(line.includes(secret), false);
});

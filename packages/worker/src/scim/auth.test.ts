// Unit tests for SCIM bearer-token authentication (constant-time compare).
// ENTRA_AUTH_SPEC.md §8: constant-time compare is a unit-test requirement distinct from
// the integration suite; this covers that invariant.
import { test } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { bearerAuth, classifyBearer, safeTokenEqual, SCIM_REJECTION_LOCAL } from "./router.js";
import { checkScimBearerToken, scimTokenFatalLog, scimTokenFingerprint, SCIM_TOKEN_MIN_LENGTH } from "./token.js";

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
    locals: {},
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
    locals: {},
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
    locals: {},
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
    locals: {},
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
    locals: {},
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

test("bearerAuth: a header of many spaces is rejected in linear time (no ReDoS)", (t, done) => {
  const middleware = bearerAuth("expected-token");
  const req = { header: () => `bearer ${" ".repeat(100_000)}\n` } as any;
  const started = Date.now();
  const res = {
    locals: {},
    status: function (code: number) {
      assert.strictEqual(code, 401);
      assert.ok(Date.now() - started < 1000, "linear in the header length");
      return { json: () => done() };
    },
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

// ── SCIM_BEARER_TOKEN edge whitespace (ENTRA_AUTH_SPEC.md §3 *Auth*) ───────────────────────

test("checkScimBearerToken: a value beginning or ending with whitespace is refused, never trimmed", () => {
  const good = "k".repeat(40);
  for (const bad of [`${good} `, ` ${good}`, `${good}
`, `${good}`, `	${good}`]) {
    assert.deepStrictEqual(checkScimBearerToken(bad), { ok: false, reason: "edge_whitespace" }, JSON.stringify(bad.slice(-2)));
  }
  assert.deepStrictEqual(checkScimBearerToken(good), { ok: true, token: good });
  // Length is judged first: a short value with a trailing space is reported as too short.
  assert.deepStrictEqual(checkScimBearerToken("short "), { ok: false, reason: "too_short" });
});

test("scimTokenFatalLog: the whitespace refusal names the variable and the rule, never the value", () => {
  const secret = `${"s".repeat(40)} `;
  const check = checkScimBearerToken(secret);
  assert.strictEqual(check.ok, false);
  if (check.ok) return;
  const line = scimTokenFatalLog(check.reason);
  const parsed = JSON.parse(line) as { level: string; variable: string; msg: string; reason: string };
  assert.strictEqual(parsed.level, "fatal");
  assert.strictEqual(parsed.variable, "SCIM_BEARER_TOKEN");
  assert.strictEqual(parsed.reason, "edge_whitespace");
  assert.match(parsed.msg, /whitespace/);
  assert.strictEqual(line.includes(secret.trim()), false);
});

// ── §14.7 rejection detail: fingerprint and reason classification ───────────────────────

test("scimTokenFingerprint: first 8 hex of SHA-256 over the UTF-8 bytes (matches sha256sum)", () => {
  assert.strictEqual(scimTokenFingerprint("abc"), "ba7816bf");
  assert.strictEqual(scimTokenFingerprint(""), "e3b0c442");
  const token = "tökén-with-ünicode";
  assert.strictEqual(scimTokenFingerprint(token), createHash("sha256").update(Buffer.from(token, "utf8")).digest("hex").slice(0, 8));
  assert.match(scimTokenFingerprint("q".repeat(64)), /^[0-9a-f]{8}$/);
});

test("classifyBearer: each reason, the fingerprints, and the whitespace flag", () => {
  const configured = "c".repeat(40);
  const fp = scimTokenFingerprint(configured);
  assert.deepStrictEqual(classifyBearer("", configured, fp), { reason: "no_token", configuredFingerprint: fp });
  assert.deepStrictEqual(classifyBearer("   ", configured, fp), { reason: "no_token", configuredFingerprint: fp });
  assert.deepStrictEqual(classifyBearer("Basic dXNlcjpwYXNz", configured, fp), { reason: "not_bearer", configuredFingerprint: fp });
  assert.deepStrictEqual(classifyBearer("Bearer", configured, fp), { reason: "not_bearer", configuredFingerprint: fp }, "Bearer with nothing after it");
  assert.deepStrictEqual(classifyBearer(configured, configured, fp), { reason: "not_bearer", configuredFingerprint: fp }, "no scheme at all");
  assert.strictEqual(classifyBearer(`Bearer ${configured}`, configured, fp), null);
  assert.strictEqual(classifyBearer(`bearer ${configured}`, configured, fp), null);
  assert.deepStrictEqual(classifyBearer("Bearer wrong-token", configured, fp), {
    reason: "token_mismatch",
    configuredFingerprint: fp,
    sentFingerprint: scimTokenFingerprint("wrong-token"),
    sentHasWhitespace: false,
  });
  const split = classifyBearer("Bearer abc def", configured, fp);
  assert.ok(split && split.reason === "token_mismatch");
  assert.strictEqual(split.sentHasWhitespace, true, "whitespace inside the sent token is flagged");
  assert.strictEqual(split.sentFingerprint, scimTokenFingerprint("abc def"));
});

test("bearerAuth: leaves only the derived verdict for the recorder — never the token", (t, done) => {
  const middleware = bearerAuth("expected-token");
  const sent = "leaked-if-stored";
  const req = { header: () => `Bearer ${sent}` } as any;
  const locals: Record<string, unknown> = {};
  const res = {
    locals,
    status: () => ({
      json: () => {
        const verdict = locals[SCIM_REJECTION_LOCAL] as { reason: string };
        assert.strictEqual(verdict.reason, "token_mismatch");
        assert.strictEqual(JSON.stringify(verdict).includes(sent), false);
        done();
      },
    }),
  } as any;
  middleware(req, res, () => done(new Error("should not call next()")));
});

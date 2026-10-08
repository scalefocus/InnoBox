// Pins the §2.4 CSRF Origin rule (INNOBOX_SPEC.md): every state-changing /api/* request outside
// Auth.js must carry an Origin equal to the canonical origin; safe methods and /api/auth/* are
// never checked. A regression here silently re-opens cross-site request forgery.
import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedOrigins, isOriginAllowed, requiresOriginCheck, type OriginCheckInput } from "./csrf";

const PROD_ENV = { PUBLIC_BASE_URL: "https://innobox.example.com" };

function check(overrides: Partial<OriginCheckInput>): boolean {
  return isOriginAllowed({
    method: "POST",
    pathname: "/api/challenges",
    origin: "https://innobox.example.com",
    requestOrigin: "http://web:3000",
    env: PROD_ENV,
    dev: false,
    ...overrides,
  });
}

test("requiresOriginCheck: state-changing methods under /api/* only", () => {
  for (const m of ["POST", "PUT", "PATCH", "DELETE", "post", "delete"]) {
    assert.equal(requiresOriginCheck(m, "/api/challenges"), true, m);
  }
  for (const m of ["GET", "HEAD", "OPTIONS"]) {
    assert.equal(requiresOriginCheck(m, "/api/challenges"), false, m);
  }
  assert.equal(requiresOriginCheck("POST", "/api"), true);
  assert.equal(requiresOriginCheck("POST", "/challenges/new"), false);
  assert.equal(requiresOriginCheck("POST", "/apiary"), false);
});

test("requiresOriginCheck: the Auth.js routes are exempt (they carry their own CSRF token)", () => {
  assert.equal(requiresOriginCheck("POST", "/api/auth"), false);
  assert.equal(requiresOriginCheck("POST", "/api/auth/signin/azure-ad"), false);
  assert.equal(requiresOriginCheck("POST", "/api/auth/signout"), false);
  // A look-alike prefix is NOT exempt.
  assert.equal(requiresOriginCheck("POST", "/api/authors"), true);
});

test("a matching Origin passes; missing, different, sibling-subdomain, or 'null' Origin is refused", () => {
  assert.equal(check({}), true);
  assert.equal(check({ origin: null }), false);
  assert.equal(check({ origin: "" }), false);
  assert.equal(check({ origin: "null" }), false);
  assert.equal(check({ origin: "https://evil.example.com" }), false);
  assert.equal(check({ origin: "https://other.innobox.example.com" }), false);
  assert.equal(check({ origin: "http://innobox.example.com" }), false, "scheme must match");
  assert.equal(check({ origin: "https://innobox.example.com:8443" }), false, "port must match");
  assert.equal(check({ origin: "not a url" }), false);
});

test("the comparison is on origin, not the full base URL (a path in PUBLIC_BASE_URL is ignored)", () => {
  assert.equal(check({ env: { PUBLIC_BASE_URL: "https://innobox.example.com/some/path" } }), true);
  assert.equal(check({ origin: "https://INNOBOX.example.com" }), true, "host is case-insensitive");
});

test("safe methods and /api/auth/* pass without any Origin", () => {
  assert.equal(check({ method: "GET", origin: null }), true);
  assert.equal(check({ method: "HEAD", origin: "https://evil.example.com" }), true);
  assert.equal(check({ pathname: "/api/auth/callback/azure-ad", origin: null }), true);
});

test("PUBLIC_BASE_URL wins; NEXTAUTH_URL is the fallback", () => {
  assert.deepEqual(allowedOrigins({ env: { PUBLIC_BASE_URL: "https://a.example.com", NEXTAUTH_URL: "https://b.example.com" }, requestOrigin: "", dev: false }), [
    "https://a.example.com",
  ]);
  assert.deepEqual(allowedOrigins({ env: { NEXTAUTH_URL: "http://127.0.0.1:3000" }, requestOrigin: "", dev: false }), ["http://127.0.0.1:3000"]);
  assert.equal(check({ env: { NEXTAUTH_URL: "https://innobox.example.com" } }), true);
});

test("the server's own origin stands in only in dev with nothing configured; production fails closed", () => {
  assert.equal(check({ env: {}, dev: true, origin: "http://localhost:3000", requestOrigin: "http://localhost:3000" }), true);
  assert.equal(check({ env: {}, dev: true, origin: "http://evil.localhost:3000", requestOrigin: "http://localhost:3000" }), false);
  assert.equal(check({ env: {}, dev: false, origin: "http://localhost:3000", requestOrigin: "http://localhost:3000" }), false);
  // Configured URL in dev: the request's own origin is NOT additionally accepted.
  assert.equal(check({ env: { NEXTAUTH_URL: "http://localhost:3000" }, dev: true, origin: "http://127.0.0.1:3000", requestOrigin: "http://127.0.0.1:3000" }), false);
});

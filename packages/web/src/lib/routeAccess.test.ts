// Guards the route-access policy (ENTRA_AUTH_SPEC.md §5, INNOBOX_SPEC.md §2.1 invariant 2): "/" is
// the sole public app route (the sign-in landing), everything else is gated. A regression here
// would expose protected pages, so the boundaries are pinned explicitly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicPath } from "./routeAccess";

test("the Home landing '/' is public (the sign-in surface)", () => {
  assert.equal(isPublicPath("/"), true);
});

test("health probes, metrics, static assets, and Auth.js endpoints are public", () => {
  for (const p of ["/healthz", "/readyz", "/metrics", "/icon.svg", "/favicon.ico"]) {
    assert.equal(isPublicPath(p), true, `${p} should be public`);
  }
  assert.equal(isPublicPath("/api/auth"), true);
  assert.equal(isPublicPath("/api/auth/session"), true);
  assert.equal(isPublicPath("/api/auth/callback/azure-ad"), true);
  assert.equal(isPublicPath("/_next/static/chunk.js"), true);
});

test("the CSP report sink is the one public API route — exact path only", () => {
  assert.equal(isPublicPath("/api/csp-report"), true);
  assert.equal(isPublicPath("/api/csp-report/"), false);
  assert.equal(isPublicPath("/api/csp-report/anything"), false);
  assert.equal(isPublicPath("/api/csp-reports"), false);
});

test("the §24 public submission form and its four API routes are public — exact paths only", () => {
  for (const p of ["/submit", "/submit/confirm", "/api/public/settings", "/api/public/pow", "/api/public/submissions", "/api/public/confirm"]) {
    assert.equal(isPublicPath(p), true, `${p} should be public`);
  }
  for (const p of ["/submit/", "/submit/other", "/submitx", "/api/public", "/api/public/", "/api/public/other", "/api/public/submissions/1"]) {
    assert.equal(isPublicPath(p), false, `${p} should stay gated`);
  }
});

test("static brand images under /brand/ are public (the sidebar logo shows on the signed-out landing)", () => {
  assert.equal(isPublicPath("/brand/innobox-light.png"), true);
  assert.equal(isPublicPath("/brand/innobox-dark.png"), true);
  // The Open Graph share card (§2.2) must be fetchable by unauthenticated OG scrapers.
  assert.equal(isPublicPath("/brand/og-card.png"), true);
  // Exact "/brand" (no trailing slash) is not a real asset and stays gated — only the /brand/ tree is public.
  assert.equal(isPublicPath("/brand"), false);
});

test("all app routes and non-auth APIs stay gated — including /whats-new (invariant 2)", () => {
  for (const p of [
    "/challenges",
    "/challenges/12",
    "/leaderboard",
    "/admin",
    "/admin/settings",
    "/profile",
    "/whats-new",
    "/api/me",
    "/api/dashboard",
    "/api/challenges",
  ]) {
    assert.equal(isPublicPath(p), false, `${p} must require a session`);
  }
});

test("public matching is exact — a route that only shares the '/' prefix is NOT public", () => {
  // Regression guard: the "/" entry must not be treated as a prefix, or every route would leak.
  assert.equal(isPublicPath("/challenges"), false);
  assert.equal(isPublicPath("/healthz/../admin"), false);
  // A path that merely starts with "/api/auth" but is a different segment is not auth-public.
  assert.equal(isPublicPath("/api/authz"), false);
});

test("§25.2 agent access: the self-authenticating routes are public, the consent routes are not", () => {
  for (const p of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/oauth/register",
    "/oauth/token",
    "/oauth/revoke",
    "/mcp",
  ]) {
    assert.equal(isPublicPath(p), true, p);
  }
  // /oauth/authorize and /oauth/consent need a session (sign-in, then back).
  for (const p of ["/oauth/authorize", "/oauth/consent", "/oauth", "/mcp/x", "/agents", "/.well-known/other"]) {
    assert.equal(isPublicPath(p), false, p);
  }
});

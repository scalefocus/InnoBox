// §13.7 onboarding redirect policy (lib/quick-start.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isQuickStartExempt, shouldRedirectToQuickStart } from "./quick-start";

test("an unseen user is redirected from every authenticated page route, Home and deep links included", () => {
  for (const path of ["/", "/challenges", "/challenges/42", "/admin/triage", "/profile", "/whats-new", "/leaderboard"]) {
    assert.equal(shouldRedirectToQuickStart(path, null), true, path);
  }
});

test("never redirected: /quick-start itself, API/auth routes, probes and static assets", () => {
  for (const path of ["/quick-start", "/api/me", "/api/auth/callback/azure-ad", "/healthz", "/readyz", "/metrics", "/_next/static/x.js", "/brand/innobox-light.png", "/favicon.ico"]) {
    assert.equal(isQuickStartExempt(path), true, path);
    assert.equal(shouldRedirectToQuickStart(path, null), false, path);
  }
});

test("a user who has seen it (or no signed-in user at all) is never redirected", () => {
  assert.equal(shouldRedirectToQuickStart("/challenges", new Date()), false);
  assert.equal(shouldRedirectToQuickStart("/challenges", "2026-01-01T00:00:00.000Z"), false);
  assert.equal(shouldRedirectToQuickStart("/challenges", undefined), false);
});

test("an unknown route fails open (the client shell still gates it)", () => {
  assert.equal(shouldRedirectToQuickStart(null, null), false);
  assert.equal(shouldRedirectToQuickStart("", null), false);
});

test("a path that merely starts with the same letters is not exempt", () => {
  assert.equal(isQuickStartExempt("/quick-starter"), false);
  assert.equal(isQuickStartExempt("/apiary"), false);
});

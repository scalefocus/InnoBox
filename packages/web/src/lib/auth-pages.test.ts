// Unit tests for the Auth.js page routing + sign-in error copy (ENTRA_AUTH_SPEC.md §5 "Sign-in
// UI": no default Auth.js page; a refused sign-in lands on `/?error=AccessDenied`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_PAGES, authErrorMessage } from "./auth-pages";

const here = path.dirname(fileURLToPath(import.meta.url));

test("AUTH_PAGES: sign-in AND error both route to the Home landing — no built-in Auth.js page", () => {
  assert.equal(AUTH_PAGES.signIn, "/");
  assert.equal(AUTH_PAGES.error, "/", "without pages.error a refused signIn renders the library error page");
});

test("authOptions wires AUTH_PAGES as its pages", () => {
  const source = readFileSync(path.join(here, "authOptions.ts"), "utf8");
  assert.match(source, /pages: \{ \.\.\.AUTH_PAGES \}/);
});

test("authErrorMessage: AccessDenied names the refusal; other codes degrade to a generic message", () => {
  assert.match(authErrorMessage("AccessDenied"), /refused/);
  assert.match(authErrorMessage("AccessDenied"), /deactivated/);
  assert.match(authErrorMessage("Configuration"), /unavailable/);
  for (const code of ["OAuthCallback", "Callback", "CredentialsSignin", "Verification", "<script>", ""]) {
    assert.equal(authErrorMessage(code), "Sign-in failed. Please try again.", code);
  }
});

test("authErrorMessage: user-facing copy carries no spec references", () => {
  for (const code of ["AccessDenied", "Configuration", "Other"]) assert.ok(!authErrorMessage(code).includes("§"));
});

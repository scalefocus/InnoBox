// Unit tests for the canonical-URL helpers (INNOBOX_SPEC.md §2.3): PUBLIC_BASE_URL only (never
// NEXTAUTH_URL), the development default outside production, and the production start-up refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEV_PUBLIC_BASE_URL, configuredPublicBaseUrl, publicBaseUrl, publicBaseUrlStartupViolation, stripTrailingSlashes } from "./public-url.js";

test("stripTrailingSlashes: drops every trailing slash, nothing else", () => {
  assert.equal(stripTrailingSlashes("https://innobox.example.com///"), "https://innobox.example.com");
  assert.equal(stripTrailingSlashes("https://innobox.example.com/sub"), "https://innobox.example.com/sub");
  assert.equal(stripTrailingSlashes("///"), "");
  assert.equal(stripTrailingSlashes(""), "");
});

test("stripTrailingSlashes: linear on a long run of slashes (no regex backtracking)", () => {
  const run = "/".repeat(200_000);
  const started = performance.now();
  assert.equal(stripTrailingSlashes(`${run}x`), `${run}x`);
  assert.equal(configuredPublicBaseUrl({ PUBLIC_BASE_URL: `https://innobox.example.com${run}` }), "https://innobox.example.com");
  assert.ok(performance.now() - started < 1_000, "a quadratic strip would take far longer");
});

test("configuredPublicBaseUrl: trimmed, trailing slashes dropped", () => {
  assert.equal(configuredPublicBaseUrl({ PUBLIC_BASE_URL: " https://innobox.example.com// " }), "https://innobox.example.com");
  assert.equal(configuredPublicBaseUrl({ PUBLIC_BASE_URL: "https://innobox.example.com/sub/" }), "https://innobox.example.com/sub");
});

test("configuredPublicBaseUrl: unset or blank → undefined, with no development default", () => {
  assert.equal(configuredPublicBaseUrl({}), undefined);
  assert.equal(configuredPublicBaseUrl({ PUBLIC_BASE_URL: "" }), undefined);
  assert.equal(configuredPublicBaseUrl({ PUBLIC_BASE_URL: "   " }), undefined);
  assert.equal(configuredPublicBaseUrl({ PUBLIC_BASE_URL: "/" }), undefined);
});

test("configuredPublicBaseUrl: NEXTAUTH_URL is never a fallback", () => {
  const env = { NEXTAUTH_URL: "https://other.example.com" } as Parameters<typeof configuredPublicBaseUrl>[0];
  assert.equal(configuredPublicBaseUrl(env), undefined);
});

test("publicBaseUrl: the configured value wins in every environment", () => {
  assert.equal(publicBaseUrl({ PUBLIC_BASE_URL: "https://innobox.example.com/", NODE_ENV: "production" }), "https://innobox.example.com");
  assert.equal(publicBaseUrl({ PUBLIC_BASE_URL: "https://innobox.example.com", NODE_ENV: "development" }), "https://innobox.example.com");
});

test("publicBaseUrl: outside production an unset or blank value is the development default", () => {
  assert.equal(publicBaseUrl({}), DEV_PUBLIC_BASE_URL);
  assert.equal(publicBaseUrl({ NODE_ENV: "development", PUBLIC_BASE_URL: "" }), "http://localhost:3000");
  assert.equal(publicBaseUrl({ NODE_ENV: "test", PUBLIC_BASE_URL: "  " }), "http://localhost:3000");
});

test("publicBaseUrl: production with nothing configured yields no host at all", () => {
  const env = { NODE_ENV: "production", NEXTAUTH_URL: "https://other.example.com" } as Parameters<typeof publicBaseUrl>[0];
  assert.equal(publicBaseUrl(env), "");
});

test("publicBaseUrlStartupViolation: production with PUBLIC_BASE_URL unset or blank refuses to start", () => {
  for (const PUBLIC_BASE_URL of [undefined, "", "   "]) {
    const fatal = publicBaseUrlStartupViolation({ NODE_ENV: "production", PUBLIC_BASE_URL });
    assert.ok(fatal, `refuses for ${JSON.stringify(PUBLIC_BASE_URL)}`);
    const parsed = JSON.parse(fatal);
    assert.equal(parsed.level, "fatal");
    assert.equal(parsed.variable, "PUBLIC_BASE_URL");
  }
});

test("publicBaseUrlStartupViolation: set in production, or any non-production env → null", () => {
  assert.equal(publicBaseUrlStartupViolation({ NODE_ENV: "production", PUBLIC_BASE_URL: "https://innobox.example.com" }), null);
  assert.equal(publicBaseUrlStartupViolation({ NODE_ENV: "development" }), null);
  assert.equal(publicBaseUrlStartupViolation({}), null);
});

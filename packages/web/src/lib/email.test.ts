// Unit tests for the e-mail channel's base URL (INNOBOX_SPEC.md §2.3): the consent redirect URI
// derives from PUBLIC_BASE_URL — no undocumented variable is consulted, and no host is baked in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { webBaseUrl } from "./email";

test("webBaseUrl: PUBLIC_BASE_URL wins", () => {
  assert.equal(
    webBaseUrl({ PUBLIC_BASE_URL: "https://innobox.example.com", NEXTAUTH_URL: "https://other.example.com", NODE_ENV: "production" }),
    "https://innobox.example.com",
  );
});

test("webBaseUrl: falls back to NEXTAUTH_URL (compose sets it to PUBLIC_BASE_URL)", () => {
  assert.equal(webBaseUrl({ PUBLIC_BASE_URL: "", NEXTAUTH_URL: "https://innobox.example.com", NODE_ENV: "production" }), "https://innobox.example.com");
});

test("webBaseUrl: a trailing slash is dropped so the redirect URI has no double slash", () => {
  assert.equal(webBaseUrl({ PUBLIC_BASE_URL: "https://innobox.example.com/", NODE_ENV: "production" }), "https://innobox.example.com");
});

test("webBaseUrl: ignores any other variable (no undocumented fallback)", () => {
  const env = { INNOBOX_REGISTRY_URL: "https://registry.example.com", NODE_ENV: "production" } as Parameters<typeof webBaseUrl>[0];
  assert.equal(webBaseUrl(env), "", "production with nothing configured yields no host at all");
});

test("webBaseUrl: development defaults to http://localhost:3000", () => {
  assert.equal(webBaseUrl({ NODE_ENV: "development" }), "http://localhost:3000");
  assert.equal(webBaseUrl({}), "http://localhost:3000");
});

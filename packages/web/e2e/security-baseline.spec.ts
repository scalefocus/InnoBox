// Web security baseline e2e (INNOBOX_SPEC.md §2.4) against the real server: the response headers
// (nonce CSP on pages, the static set on every response, no X-Powered-By), a page that renders
// and hydrates under that CSP without violations, and the CSRF Origin check on state-changing API
// requests (a foreign or missing Origin is refused before the route runs).
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";

const base = process.env.E2E_BASE_URL || "http://localhost:3000";

test("pages carry a per-request nonce CSP and the static security headers; no X-Powered-By", async ({ browser }) => {
  const ctx = await browser.newContext(); // the public landing needs no session
  const first = await ctx.request.get(`${base}/`);
  const second = await ctx.request.get(`${base}/`);
  const csp = first.headers()["content-security-policy"] ?? "";
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  // A fresh nonce every request.
  const nonceOf = (v: string) => /'nonce-([^']+)'/.exec(v)?.[1];
  expect(nonceOf(second.headers()["content-security-policy"] ?? "")).not.toBe(nonceOf(csp));

  for (const res of [first, await ctx.request.get(`${base}/healthz`), await ctx.request.get(`${base}/api/auth/csrf`)]) {
    const h = res.headers();
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["cross-origin-opener-policy"]).toBe("same-origin");
    expect(h["permissions-policy"]).toContain("camera=()");
    expect(h["x-powered-by"]).toBeUndefined();
  }
  await ctx.close();
});

test("a signed-in page renders and hydrates under the CSP with no violations", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E CSP ${stamp}` });
  const page = await ctx.newPage();
  const violations: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && /Content Security Policy/i.test(msg.text())) violations.push(msg.text());
  });
  await page.goto("/challenges");
  // The account menu is client-rendered: visible + interactive means the scripts ran.
  await page.locator(".user-trigger").click();
  await expect(page.getByRole("menuitem", { name: /what's new/i })).toBeVisible();
  // The theme-init inline script (nonce'd) ran before paint.
  await expect(page.locator("html")).toHaveAttribute("data-theme", /^(light|dark)$/);
  expect(violations).toEqual([]);
  await ctx.close();
});

test("state-changing API requests from a foreign or missing Origin are refused with 403", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E CSRF ${stamp}` });
  const body = { quickStartSeen: true };
  const json = { "content-type": "application/json", accept: "application/json" };

  const foreign = await ctx.request.patch(`${base}/api/me`, { data: body, headers: { ...json, origin: "https://evil.example.com" } });
  expect(foreign.status()).toBe(403);
  const opaque = await ctx.request.patch(`${base}/api/me`, { data: body, headers: { ...json, origin: "null" } });
  expect(opaque.status()).toBe(403);

  // The same request from our own origin goes through; safe methods are never checked.
  const own = await ctx.request.patch(`${base}/api/me`, { data: body, headers: json });
  expect(own.status()).toBe(200);
  const read = await ctx.request.get(`${base}/api/me`, { headers: { accept: "application/json", origin: "https://evil.example.com" } });
  expect(read.status()).toBe(200);

  // A JSON endpoint refuses a non-JSON body (a plain HTML form cannot forge one): 415.
  const form = await ctx.request.patch(`${base}/api/me`, { form: { quickStartSeen: "true" } });
  expect(form.status()).toBe(415);
  await ctx.close();
});

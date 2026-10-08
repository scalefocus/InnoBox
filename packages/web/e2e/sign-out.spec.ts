// Sign-out cookie sweep e2e (INNOBOX_SPEC.md §3 "Sign-out"): an accepted sign-out leaves no
// Auth.js cookie behind — every session chunk (an orphaned one included), the CSRF token, the
// callback URL and an unfinished sign-in's state cookie — while non-auth state survives; a
// CSRF-rejected sign-out sweeps nothing and keeps the session.
import { test, expect, type BrowserContext } from "@playwright/test";
import { signIn } from "./helpers/auth";

const base = process.env.E2E_BASE_URL || "http://localhost:3000";
const host = new URL(base).hostname;

/** Leftovers of an unfinished sign-in plus a non-auth cookie the sweep must not touch. */
async function plantLeftovers(ctx: BrowserContext): Promise<void> {
  await ctx.addCookies([
    { name: "next-auth.state", value: "unfinished", domain: host, path: "/" },
    { name: "e2e-theme-probe", value: "dark", domain: host, path: "/" },
  ]);
}

const authCookies = async (ctx: BrowserContext) =>
  (await ctx.cookies(base)).map((c) => c.name).filter((n) => n.replace(/^__(Secure|Host)-/, "").startsWith("next-auth."));

test("Sign out from the account menu clears every Auth.js cookie and keeps non-auth state", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Signout ${stamp}` });
  await plantLeftovers(ctx);
  const page = await ctx.newPage();
  await page.goto(`${base}/`);
  await page.locator(".user-trigger").click();
  // An orphaned session chunk (planted only now: Auth.js would re-assemble it into the live
  // session) must be swept by the sign-out, read from the request — never guessed.
  await ctx.addCookies([{ name: "next-auth.session-token.5", value: "orphan-chunk", domain: host, path: "/" }]);
  const signedOut = page.waitForResponse((r) => r.url().includes("/api/auth/signout") && r.request().method() === "POST");
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  const res = await signedOut;
  // The sign-out response itself expires every auth cookie the browser carried.
  const expired = (await res.headersArray())
    .filter((h) => h.name.toLowerCase() === "set-cookie" && /Max-Age=0/i.test(h.value))
    .map((h) => h.value.split("=")[0]);
  expect(expired).toEqual(expect.arrayContaining(["next-auth.session-token.5", "next-auth.state"]));
  expect(expired.some((n) => /next-auth\.(csrf-token|callback-url)$/.test(n))).toBe(true);

  await page.locator("#dev-name").waitFor({ state: "visible" }); // back on the signed-out landing
  const remaining = await authCookies(ctx);
  expect(remaining.filter((n) => /session-token/.test(n))).toEqual([]);
  expect(remaining).not.toContain("next-auth.state");
  expect((await ctx.cookies(base)).some((c) => c.name === "e2e-theme-probe")).toBe(true);
  const me = await ctx.request.get(`${base}/api/me`, { headers: { accept: "application/json" } });
  expect(me.status()).toBe(401);
  await ctx.close();
});

test("a CSRF-rejected sign-out sweeps nothing and keeps the session", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Signout CSRF ${stamp}` });
  await plantLeftovers(ctx);
  const res = await ctx.request.post(`${base}/api/auth/signout`, {
    headers: { Origin: new URL(base).origin },
    form: { csrfToken: "not-the-token", callbackUrl: `${base}/`, json: "true" },
  });
  const expired = res.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie" && /Max-Age=0/i.test(h.value));
  expect(expired).toEqual([]);
  const kept = await authCookies(ctx);
  expect(kept.some((n) => /session-token/.test(n))).toBe(true);
  expect(kept).toContain("next-auth.state");
  const me = await ctx.request.get(`${base}/api/me`, { headers: { accept: "application/json" } });
  expect(me.status()).toBe(200);
  await ctx.close();
});

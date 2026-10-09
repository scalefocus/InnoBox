// Sign-in error path e2e (ENTRA_AUTH_SPEC.md §5 "Sign-in UI"; INNOBOX_SPEC.md §3, §13.2): a
// refused `signIn` callback makes Auth.js redirect to its error action with `AccessDenied`; with
// no default Auth.js page, that lands on the Home landing as `/?error=AccessDenied`, which shows
// a short message — never the library's built-in error page.
import { test, expect } from "@playwright/test";

const base = process.env.E2E_BASE_URL || "http://localhost:3000";

test("a refused sign-in is handed back to the Home landing as ?error=AccessDenied", async ({ browser }) => {
  const ctx = await browser.newContext(); // signed out — exactly the refused-sign-in situation
  // The redirect Auth.js issues after a callback returns false.
  const hop = await ctx.request.get(`${base}/api/auth/error?error=AccessDenied`, { maxRedirects: 0 });
  expect(hop.status()).toBeGreaterThanOrEqual(300);
  expect(hop.status()).toBeLessThan(400);
  expect(new URL(hop.headers()["location"] ?? "", base).pathname).toBe("/");
  expect(new URL(hop.headers()["location"] ?? "", base).searchParams.get("error")).toBe("AccessDenied");

  const page = await ctx.newPage();
  await page.goto(`${base}/api/auth/error?error=AccessDenied`);
  await expect(page).toHaveURL(/\/\?error=AccessDenied$/);
  await expect(page.getByRole("alert").filter({ hasText: "Sign-in was refused" })).toBeVisible();
  // The built-in Auth.js error page is never rendered.
  await expect(page.getByText("You do not have permission to sign in.")).toHaveCount(0);
  await ctx.close();
});

test("any other Auth.js error code also lands on the landing with a generic message", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${base}/api/auth/error?error=Verification`);
  await expect(page).toHaveURL(/\/\?error=Verification$/);
  await expect(page.getByRole("alert").filter({ hasText: "Sign-in failed. Please try again." })).toBeVisible();
  await ctx.close();
});

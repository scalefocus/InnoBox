// Quick start onboarding (INNOBOX_SPEC.md §13.7): a genuinely first-time sign-in is
// redirected to /quick-start before anything else; "Continue to InnoBox" marks it seen and
// returns to "/", after which the redirect never fires again. Ordinary dev/e2e personas
// (freshOnboarding omitted) must NOT be redirected — every other e2e spec depends on that.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";

test("first sign-in redirects to /quick-start; Continue marks it seen and returns to Home", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Onboarding ${stamp}`, freshOnboarding: true });
  const page = await ctx.newPage();

  await page.goto("/");
  await expect(page).toHaveURL(/\/quick-start$/);
  await expect(page.getByRole("heading", { name: "Quick start" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Submit a challenge" })).toBeVisible();

  // Any other authenticated route bounces back here too, while still unseen.
  await page.goto("/challenges");
  await expect(page).toHaveURL(/\/quick-start$/);

  await page.goto("/quick-start");
  await page.getByRole("button", { name: "Continue to InnoBox" }).click();
  await expect(page).toHaveURL(/\/$/);

  // Seen now — reloading Home must not bounce back.
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);

  await ctx.close();
});

test("an ordinary dev sign-in (freshOnboarding omitted) is never redirected to /quick-start", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Regular ${stamp}` });
  const page = await ctx.newPage();

  await page.goto("/challenges");
  await expect(page).toHaveURL(/\/challenges$/);

  await ctx.close();
});

test("the account menu's Quick start link is always reachable, even once seen", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E MenuLink ${stamp}` });
  const page = await ctx.newPage();
  await page.goto("/");

  await page.locator(".user-trigger").click();
  await page.getByRole("menuitem", { name: "Quick start" }).click();
  await expect(page).toHaveURL(/\/quick-start$/);
  await expect(page.getByRole("heading", { name: "Quick start" })).toBeVisible();

  await ctx.close();
});

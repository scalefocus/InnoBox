// Quick start onboarding (INNOBOX_SPEC.md §13.7): a genuinely first-time sign-in is
// redirected to /quick-start before anything else; "Continue to InnoBox" marks it seen and
// returns to "/", after which the redirect never fires again. Ordinary dev/e2e personas
// (freshOnboarding omitted) must NOT be redirected — every other e2e spec depends on that.
//
// The action is on the page twice (the page head and after the last section), and while a user is
// unseen the head says that the rest of the app is held — every navigation leads back here until
// they continue, so the way out has to be on the first screen.
import { test, expect, type Page } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { uniqueStamp } from "./helpers/stamp";

/** The Continue action in the page head — the one on the first screen. */
const headAction = (page: Page) => page.locator(".page-head").getByRole("button", { name: "Continue to InnoBox" });
/** The Continue action after the last section. */
const footAction = (page: Page) => page.getByRole("button", { name: "Continue to InnoBox" }).last();
/** The line an unseen user gets beside the head action. */
const heldLine = (page: Page) => page.getByText("The rest of InnoBox opens once you continue.");

test("first sign-in redirects to /quick-start; Continue marks it seen and returns to Home", async ({ browser }) => {
  const stamp = uniqueStamp();
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Onboarding ${stamp}`, freshOnboarding: true });
  const page = await ctx.newPage();

  await page.goto("/");
  await expect(page).toHaveURL(/\/quick-start$/);
  await expect(page.getByRole("heading", { name: "Quick start" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Submit a challenge" })).toBeVisible();

  // Any other authenticated route bounces back here too, while still unseen — and it does so
  // BEFORE rendering: the navigation is an HTTP redirect, so the requested page never paints.
  const res = await page.goto("/challenges/42");
  await expect(page).toHaveURL(/\/quick-start$/);
  expect(res?.request().redirectedFrom()?.url(), "a server-side redirect, not a client bounce").toMatch(/\/challenges\/42$/);

  await page.goto("/quick-start");
  await footAction(page).click();
  await expect(page).toHaveURL(/\/$/);

  // Seen now — reloading Home must not bounce back.
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);

  await ctx.close();
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`unseen at ${viewport.name} width: the Continue action and the held line are on the first screen`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    await signIn(ctx, { name: `E2E Onboarding First Screen ${viewport.name} ${uniqueStamp()}`, freshOnboarding: true });
    const page = await ctx.newPage();

    await page.goto("/");
    await expect(page).toHaveURL(/\/quick-start$/);
    await expect(headAction(page)).toBeInViewport({ ratio: 1 });
    await expect(heldLine(page)).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => window.scrollY), "in view without scrolling").toBe(0);

    await ctx.close();
  });
}

test("unseen: a navigation that is sent back lands with the page head in view", async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Onboarding Bounce ${uniqueStamp()}`, freshOnboarding: true });
  const page = await ctx.newPage();

  await page.goto("/quick-start");
  // The held line means `me` has loaded, so the shell's gate is armed for in-app navigations.
  await expect(heldLine(page)).toBeVisible();

  // From the bottom of the page, where the head is out of sight: a sidebar item.
  await footAction(page).scrollIntoViewIfNeeded();
  await expect(headAction(page)).not.toBeInViewport();
  await page.locator('a.nav-item[href="/challenges"]').click();
  await expect(headAction(page)).toBeInViewport({ ratio: 1 });
  await expect(heldLine(page)).toBeInViewport({ ratio: 1 });
  await expect(page).toHaveURL(/\/quick-start$/);

  // And a link inside the walkthrough itself.
  const topics = page.getByRole("link", { name: "Browse topics" });
  await topics.scrollIntoViewIfNeeded();
  await expect(headAction(page)).not.toBeInViewport();
  await topics.click();
  await expect(headAction(page)).toBeInViewport({ ratio: 1 });
  await expect(page).toHaveURL(/\/quick-start$/);

  await ctx.close();
});

test("unseen: the page-head action alone completes onboarding", async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Onboarding Head ${uniqueStamp()}`, freshOnboarding: true });
  const page = await ctx.newPage();

  await page.goto("/");
  await expect(page).toHaveURL(/\/quick-start$/);
  await headAction(page).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/challenges");
  await expect(page).toHaveURL(/\/challenges$/);

  await ctx.close();
});

test("unseen: a Continue that fails stays on the page and says so; the retry succeeds", async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Onboarding Failure ${uniqueStamp()}`, freshOnboarding: true });
  const page = await ctx.newPage();

  await page.goto("/quick-start");
  await expect(heldLine(page)).toBeVisible();
  // Filtered by its text: Next's own route announcer is a `role="alert"` too.
  const error = page.getByRole("alert").filter({ hasText: "That didn't save. Please try again." });

  let mode: "no-response" | "refused" | "pass" = "no-response";
  await page.route("**/api/me", (route) => {
    if (route.request().method() !== "PATCH" || mode === "pass") return route.fallback();
    if (mode === "no-response") return route.abort();
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "internal" }) });
  });

  // No response at all: stays here, the error is beside the action that was pressed, and both
  // actions are usable again.
  await headAction(page).click();
  await expect(page.locator(".page-head").getByRole("alert")).toHaveText("That didn't save. Please try again.");
  await expect(error).toHaveCount(1);
  await expect(page).toHaveURL(/\/quick-start$/);
  await expect(headAction(page)).toBeEnabled();
  await expect(footAction(page)).toBeEnabled();

  // A refusal, this time from the lower action: the earlier error is cleared, the new one is here.
  mode = "refused";
  await footAction(page).click();
  await expect(error).toHaveCount(1);
  await expect(page.locator(".page-head").getByRole("alert")).toHaveCount(0);
  await expect(page).toHaveURL(/\/quick-start$/);
  await expect(footAction(page)).toBeEnabled();

  // Nothing was saved by the failures — the user is still held.
  await page.goto("/challenges");
  await expect(page).toHaveURL(/\/quick-start$/);

  mode = "pass";
  await footAction(page).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);

  await ctx.close();
});

test("an ordinary dev sign-in (freshOnboarding omitted) is never redirected to /quick-start", async ({ browser }) => {
  const stamp = uniqueStamp();
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Regular ${stamp}` });
  const page = await ctx.newPage();

  await page.goto("/challenges");
  await expect(page).toHaveURL(/\/challenges$/);

  await ctx.close();
});

test("the account menu's Quick start link is always reachable, even once seen", async ({ browser }) => {
  const stamp = uniqueStamp();
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E MenuLink ${stamp}` });
  const page = await ctx.newPage();
  await page.goto("/");

  await page.locator(".user-trigger").click();
  await page.getByRole("menuitem", { name: "Quick start" }).click();
  await expect(page).toHaveURL(/\/quick-start$/);
  await expect(page.getByRole("heading", { name: "Quick start" })).toBeVisible();

  // A returning visitor gets the page-head action, and no word about the app being held.
  await expect(headAction(page)).toBeVisible();
  await expect(footAction(page)).toBeVisible();
  await expect(heldLine(page)).toHaveCount(0);

  await ctx.close();
});

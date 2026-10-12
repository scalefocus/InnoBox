// Feedback survey e2e (INNOBOX_SPEC.md §13.10, §14.11). The roll is 1 in 3 and server-side, so
// the personas here sign in with the dev survey flag: survey-eligible at once (Quick start 15 days
// ago, no survey history) and every roll forced to win — a seam behind the dev-auth production
// guard (lib/survey-dev.ts). Every other spec's personas sign in with surveys OFF, so the card never
// appears in their flows or screenshots.
//
// Opening /leaderboard is the trigger used throughout: a page-view first use, reported once the
// shell has made its What's new decision, with no fixtures to create.
import { test, expect, type Page } from "@playwright/test";
import { signIn } from "./helpers/auth";

async function openAccountMenu(page: Page) {
  await page.locator(".user-trigger").click();
}

test("a first use shows the card; ✕ keeps the offer in the menu; reopening and submitting thanks and clears it", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Surveyed ${stamp}`, survey: true });
  const page = await ctx.newPage();

  await page.goto("/leaderboard");
  const card = page.getByTestId("survey-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("heading", { name: "How are we doing?" })).toBeVisible();
  await expect(card.getByText("About the leaderboard")).toBeVisible();
  // Non-modal and never steals focus.
  await expect(card).toHaveAttribute("aria-modal", "false");
  await expect(card).not.toBeFocused();

  // ✕ is "not now": the card goes, Take the survey leads the account menu.
  await card.getByRole("button", { name: "Close survey" }).click();
  await expect(card).toBeHidden();
  await openAccountMenu(page);
  const take = page.getByTestId("menu-take-survey");
  await expect(take).toBeVisible();
  await take.click();

  // Reopened blank; Submit is disabled until something is answered.
  await expect(card).toBeVisible();
  const submit = card.getByRole("button", { name: "Submit" });
  await expect(submit).toBeDisabled();
  await card.getByRole("radiogroup", { name: "Overall, how satisfied are you with InnoBox?" }).getByRole("radio", { name: "4 stars" }).click();
  await card.getByLabel("Anything you'd change, fix or add?").fill(`E2E survey comment ${stamp}`);
  await expect(card.getByText(/\d+ \/ 2000/)).toBeVisible();
  await submit.click();
  await expect(card.getByText("Thanks — your feedback helps shape InnoBox.")).toBeVisible();

  await page.reload();
  await openAccountMenu(page);
  await expect(page.getByRole("menuitem", { name: "My profile" })).toBeVisible();
  await expect(page.getByTestId("menu-take-survey")).toHaveCount(0);

  await ctx.close();
});

test("Don't ask me again turns the profile switch off", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Survey OptOut ${stamp}`, survey: true });
  const page = await ctx.newPage();

  await page.goto("/leaderboard");
  const card = page.getByTestId("survey-card");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Don't ask me again" }).click();
  await expect(card).toBeHidden();
  await expect(page.getByText("Got it — no more surveys. You can turn them back on in your profile.")).toBeVisible();

  await page.goto("/profile");
  await expect(page.getByTestId("profile-survey-switch")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("You won't be asked to take surveys.")).toBeVisible();
  await ctx.close();
});

test("at mobile width the card is a bottom sheet with ✕ and Submit visible", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext({ viewport: { width: 375, height: 740 } });
  await signIn(ctx, { name: `E2E Survey Mobile ${stamp}`, survey: true });
  const page = await ctx.newPage();

  await page.goto("/leaderboard");
  const card = page.getByTestId("survey-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Close survey" })).toBeInViewport();
  await expect(card.getByRole("button", { name: "Submit" })).toBeInViewport();
  const box = await card.boundingBox();
  expect(box?.width).toBe(375);
  expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(740);

  // Opening the nav drawer hides the card (not unmounted); closing it brings it back.
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(card).toBeHidden();
  await page.getByRole("button", { name: "Close menu" }).click();
  await expect(card).toBeVisible();
  await ctx.close();
});

test("with the What's new notice due, a first use produces no survey — What's new always wins", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  // An old marker makes the update notice due on this load.
  await signIn(ctx, { name: `E2E Survey Notice ${stamp}`, survey: true, whatsNewSeen: "0.1.0" });
  const page = await ctx.newPage();
  await page.goto("/leaderboard");
  await expect(page.getByRole("heading", { name: "Leaderboard" })).toBeVisible();
  await expect(page.locator(".update-notice")).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("survey-card")).toHaveCount(0);
  await ctx.close();
});

test("a persona with surveys off never sees the card", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E No Survey ${stamp}` });
  const page = await ctx.newPage();
  await page.goto("/leaderboard");
  await expect(page.getByRole("heading", { name: "Leaderboard" })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("survey-card")).toHaveCount(0);
  await ctx.close();
});

test("admin: the Survey results card shows the funnel; its switch works while collapsed; members get 403", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Survey Admin ${stamp}`, admin: true });
  const page = await ctx.newPage();

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Survey results" })).toBeVisible();
  await expect(page.getByTestId("survey-funnel")).toBeVisible();
  await expect(page.getByTestId("survey-source")).toBeVisible();

  // Collapse the card, then flip the switch off and on again from its header.
  const head = page.getByRole("button", { name: /Survey results/ });
  if ((await head.getAttribute("aria-expanded")) === "true") await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "false");
  const toggle = page.getByTestId("survey-switch");
  const flip = async () => {
    const saved = page.waitForResponse((r) => r.url().includes("/api/admin/settings") && r.request().method() === "PATCH");
    await toggle.click();
    expect((await saved).ok()).toBe(true);
  };
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await flip();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await flip(); // back on, so the other specs' surveys keep working
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await head.click(); // leave it expanded for later runs

  const member = await browser.newContext();
  await signIn(member, { name: `E2E Survey Member ${stamp}` });
  const res = await member.request.get("/api/admin/survey/summary");
  expect(res.status()).toBe(403);
  await member.close();
  await ctx.close();
});

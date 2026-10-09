// Discovery & profile surfaces e2e (INNOBOX_SPEC.md §13.2–13.5). Read-mostly pages that every
// signed-in user relies on: the Home dashboard, the leaderboard, What's new, the profile (own +
// public), and the search results page. All driven through stable buttons/links/inputs.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi } from "./helpers/api";

test("dashboard: a signed-in member sees KPIs, quick links, and the account menu", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Dash Member ${stamp}` });
  const page = await ctx.newPage();
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Ideas worth building start here" })).toBeVisible();
  // KPI tiles (challenge + solution counts) render their status labels.
  await expect(page.locator(".stat-label", { hasText: "Solved" })).toBeVisible();
  await expect(page.locator(".stat-label", { hasText: "In review" }).first()).toBeVisible();
  // The authenticated quick links (absent when signed out — see access-control.spec.ts).
  await expect(page.getByRole("link", { name: "Browse challenges" })).toBeVisible();
  await expect(page.getByRole("link", { name: "See the leaderboard" })).toBeVisible();

  // The account menu exposes the profile / what's-new entries, and the colophon links the version.
  await page.locator(".user-trigger").click();
  await expect(page.getByRole("menuitem", { name: "My profile" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "What's new" })).toBeVisible();
  await expect(page.getByRole("link", { name: /^v\d+\.\d+\.\d+$/ })).toBeVisible();
  // Colophon attribution (§2.2): version, then both attribution lines, in that order.
  await expect(page.locator(".colophon .colophon-sub")).toHaveText([
    "Created by Scalefocus",
    "Powered by the community",
  ]);

  await ctx.close();
});

test("leaderboard: metric and window toggles change the active selection", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Board Member ${stamp}` });
  const page = await ctx.newPage();
  await page.goto("/leaderboard");
  await expect(page.getByRole("heading", { name: "Leaderboard" })).toBeVisible();

  const proposed = page.getByRole("button", { name: "Solutions proposed" });
  await proposed.click();
  await expect(proposed).toHaveClass(/btn-primary/);

  const last30 = page.getByRole("button", { name: "Last 30 days" });
  await last30.click();
  await expect(last30).toHaveClass(/btn-primary/);

  await ctx.close();
});

test("what's new: the changelog lists released versions newest-first", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Notes Member ${stamp}` });
  const page = await ctx.newPage();
  await page.goto("/whats-new");
  await expect(page.getByRole("heading", { name: "What's new" })).toBeVisible();

  const versionChips = page.locator(".chip.chip-accent");
  await expect(versionChips.first()).toBeVisible();
  await expect(versionChips.first()).toHaveText(/^v\d+\.\d+\.\d+$/);

  await ctx.close();
});

test("profile: the e-mail-notifications toggle round-trips, and the public profile loads", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const name = `E2E Profile Member ${stamp}`;
  const ctx = await browser.newContext();
  const { userId } = await signIn(ctx, { name });
  const page = await ctx.newPage();

  await page.goto("/profile");
  await expect(page.getByRole("heading", { name })).toBeVisible(); // page title is the display name

  // In-app notifications are always on; this switch toggles e-mail delivery only (§13.5).
  // It is a pill switch, so the state lives in aria-checked — assert that flips, and that
  // the visible On/Off word next to it follows.
  const emailSwitch = page.getByRole("switch", { name: "E-mail notifications" });
  const before = await emailSwitch.getAttribute("aria-checked");
  const after = before === "true" ? "false" : "true";
  await emailSwitch.click();
  await expect(emailSwitch).toHaveAttribute("aria-checked", after);
  // The page carries one switch per notification preference (§12.1) — read the word that sits
  // beside THIS switch, inside its own .toggle-field.
  const emailField = page.locator(".toggle-field", { has: emailSwitch });
  await expect(emailField.locator(".toggle-state")).toHaveText(after === "true" ? "On" : "Off");
  // The flip is persisted, not just optimistic — it survives a reload.
  await page.reload();
  await expect(page.getByRole("switch", { name: "E-mail notifications" })).toHaveAttribute("aria-checked", after);

  // The public profile (by user id) renders the same person with its public sections.
  await page.goto(`/profile/${userId}`);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Challenges" })).toBeVisible();

  await ctx.close();
});

test("search results: an exact number lookup finds a challenge; gibberish yields the empty state", async ({
  browser,
}) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Find Member ${stamp}` });
  // The searcher is the author, so they can see their own (still-untriaged) challenge.
  const challenge = await createChallengeViaApi(ctx.request, {
    title: `E2E findable challenge ${stamp}`,
    description: "Look me up by number.",
  });
  const page = await ctx.newPage();

  // Exact CH-number lookup returns the row (the page auto-searches from ?q=).
  await page.goto(`/search?q=CH-${challenge.digits}`);
  await expect(page.locator(".chip.mono", { hasText: challenge.number })).toBeVisible();
  await page.locator(".rows .row", { hasText: challenge.number }).first().click();
  await expect(page).toHaveURL(new RegExp(`/challenges/${challenge.digits}$`));

  // A query that matches nothing shows both empty states.
  await page.goto(`/search?q=zzznomatch${stamp}`);
  await expect(page.getByText("No matching challenges.")).toBeVisible();
  await expect(page.getByText("No matching solutions.")).toBeVisible();

  await ctx.close();
});

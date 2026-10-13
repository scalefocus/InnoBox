// Discovery & profile surfaces e2e (INNOBOX_SPEC.md §13.2–13.5). Read-mostly pages that every
// signed-in user relies on: the Home dashboard, the leaderboard, What's new, the profile (own +
// public), and the search results page. All driven through stable buttons/links/inputs.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi } from "./helpers/api";
import { UPCOMING } from "../src/app/whats-new/upcoming";

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
  // Colophon attribution (§2.2): version, then both attribution lines, in that order. Signed in,
  // the community line may end in the §13.10 "· Have your say" link.
  const colophonLines = page.locator(".colophon .colophon-sub");
  await expect(colophonLines).toHaveCount(2);
  await expect(colophonLines.first()).toHaveText("Created by Scalefocus");
  await expect(colophonLines.nth(1)).toContainText("Powered by the community");

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

test("what's new: Coming soon starts collapsed, expands on click, and hides admin-only teasers from members", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Soon Member ${stamp}` });
  const page = await ctx.newPage();
  await page.goto("/whats-new");

  // Driven by the live teaser list, never by named features — those ship and leave the list.
  const toggle = page.locator(".soon-head");
  const forMembers = UPCOMING.filter((e) => e.audience === "everyone");
  if (forMembers.length === 0) {
    // Nothing applies to a member → the section is hidden entirely.
    await expect(page.getByRole("heading", { name: "What's new" })).toBeVisible();
    await expect(toggle).toHaveCount(0);
    await ctx.close();
    return;
  }

  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("list", { name: "Coming soon" })).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const list = page.getByRole("list", { name: "Coming soon" });
  await expect(list).toBeVisible();
  await expect(list.getByText(forMembers[0]!.title, { exact: true })).toBeVisible();
  // Admin-only teasers are hidden from members.
  for (const entry of UPCOMING.filter((e) => e.audience !== "everyone")) {
    await expect(list.getByText(entry.title, { exact: true })).toHaveCount(0);
  }

  await toggle.click();
  await expect(page.getByRole("list", { name: "Coming soon" })).toHaveCount(0);

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

test("profile: the e-mail delivery choice round-trips, names the next digest, and waits on the e-mail switch", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Digest Member ${stamp}` });
  const page = await ctx.newPage();
  await page.goto("/profile");

  // §12.1: a three-option choice, Immediately by default; a digest names its next send.
  const delivery = page.getByTestId("profile-email-delivery");
  await expect(delivery.getByRole("radio", { name: "Immediately" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("profile-next-digest")).toHaveCount(0);
  await delivery.getByRole("radio", { name: "Weekly digest" }).click();
  await expect(delivery.getByRole("radio", { name: "Weekly digest" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("profile-next-digest")).toContainText("Next digest:");

  // Persisted, not just optimistic.
  await page.reload();
  await expect(page.getByTestId("profile-email-delivery").getByRole("radio", { name: "Weekly digest" })).toHaveAttribute("aria-checked", "true");

  // With e-mail off there is nothing to deliver: the choice is disabled and the next send hidden.
  const emailSwitch = page.getByRole("switch", { name: "E-mail notifications" });
  if ((await emailSwitch.getAttribute("aria-checked")) === "true") await emailSwitch.click();
  await expect(emailSwitch).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("profile-email-delivery").getByRole("radio", { name: "Daily digest" })).toBeDisabled();
  await expect(page.getByTestId("profile-next-digest")).toHaveCount(0);

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

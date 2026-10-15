// Feedback survey e2e (INNOBOX_SPEC.md §13.10, §14.11). The roll is 1 in 3 and server-side, so
// the personas here sign in with the dev survey flag: survey-eligible at once (Quick start 15 days
// ago, no survey history) and every roll forced to win — a seam behind the dev-auth production
// guard (lib/survey-dev.ts). Every other spec's personas sign in with surveys OFF, so the card never
// appears in their flows or screenshots.
//
// Opening /leaderboard is the trigger used throughout: a page-view first use, reported once the
// shell has made its What's new decision, with no fixtures to create.
//
// The bug-report specs at the end sign in without the flag: the bug button ignores the random
// opt-out. One of them flips the Bug reports switch and always flips it back.
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
  // Poll the geometry: the card slides up on mount, so a single read can land mid-animation.
  await expect
    .poll(async () => {
      const box = await card.boundingBox();
      return box && { width: box.width, bottom: Math.round(box.y + box.height) };
    })
    .toEqual({ width: 375, bottom: 740 });

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

// ── On-demand ("Give feedback", "Have your say") ──────────────────────────────────────────
// These personas sign in WITHOUT the survey flag: the on-demand path bypasses the random opt-out.

test("Give feedback now opens the on-demand card; a picked feature adds its questions; then the cooldown", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Give Feedback ${stamp}` });
  const page = await ctx.newPage();

  await page.goto("/profile");
  const give = page.getByTestId("profile-give-feedback");
  await expect(give).toBeEnabled();
  await expect(page.getByText("Tell us what you think, any time. Once a week at most.")).toBeVisible();
  await give.click();

  const card = page.getByTestId("survey-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Don't ask me again" })).toHaveCount(0);
  await expect(card.getByText("About search")).toHaveCount(0);
  await card.getByTestId("survey-topic").selectOption("search");
  await expect(card.getByText("About search")).toBeVisible();
  await card.getByRole("radiogroup", { name: "How easy was search to use?" }).getByRole("radio", { name: "5 stars" }).click();
  await card.getByRole("button", { name: "Submit" }).click();
  await expect(card.getByText("Thanks — your feedback helps shape InnoBox.")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("profile-give-feedback")).toBeDisabled();
  await expect(page.getByTestId("profile-give-feedback-help")).toContainText("You can share feedback again on");
  // The menu item and the colophon link are hidden during the cooldown too.
  await page.locator(".user-trigger").click();
  await expect(page.getByRole("menuitem", { name: "My profile" })).toBeVisible();
  await expect(page.getByTestId("menu-give-feedback")).toHaveCount(0);
  await expect(page.getByTestId("colophon-have-your-say")).toHaveCount(0);
  await ctx.close();
});

test("the colophon's Have your say: absent signed out; opens the card; survives a close and reopens the same offer", async ({ browser }) => {
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto("/");
  await expect(anonPage.locator(".colophon")).toBeVisible();
  await expect(anonPage.getByTestId("colophon-have-your-say")).toHaveCount(0);
  await expect(anonPage.locator(".colophon .colophon-sub").nth(1)).toHaveText("Powered by the community");
  await anon.close();

  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Have Your Say ${stamp}` });
  const page = await ctx.newPage();
  await page.goto("/");
  // The account menu offers it too, above Sign out.
  await page.locator(".user-trigger").click();
  await expect(page.getByTestId("menu-give-feedback")).toBeVisible();
  await page.locator(".user-trigger").click();

  const link = page.getByTestId("colophon-have-your-say");
  await expect(link).toBeVisible();
  await link.click();
  const card = page.getByTestId("survey-card");
  await expect(card).toBeVisible();
  await card.getByTestId("survey-topic").selectOption("comment");
  await card.getByRole("button", { name: "Close survey" }).click();
  await expect(card).toBeHidden();

  // The offer stays open: the link stays, and reopens it blank (the picked feature is not kept).
  await expect(link).toBeVisible();
  await link.click();
  await expect(card).toBeVisible();
  await expect(card.getByTestId("survey-topic")).toHaveValue("");
  await page.locator(".user-trigger").click();
  await expect(page.getByTestId("menu-take-survey")).toBeVisible();
  await expect(page.getByTestId("menu-give-feedback")).toHaveCount(0);
  await ctx.close();
});

// ── Bug reports (the sidebar bug button) ──────────────────────────────────────────────────
// Signed in WITHOUT the survey flag too: the random opt-out does not hide the button.

test("the bug button: absent signed out; opens Report a bug with no stars; Submit needs text; no cooldown", async ({ browser }) => {
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto("/");
  await expect(anonPage.locator(".colophon")).toBeVisible();
  await expect(anonPage.getByTestId("report-bug")).toHaveCount(0);
  await anon.close();

  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Bug Reporter ${stamp}` });
  const page = await ctx.newPage();
  await page.goto("/leaderboard");

  const bug = page.getByTestId("report-bug");
  await expect(bug).toBeVisible();
  await expect(bug).toHaveAttribute("aria-label", "Report a bug");
  await bug.click();
  const card = page.getByTestId("survey-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("heading", { name: "Report a bug" })).toBeVisible();
  await expect(card.getByTestId("survey-topic")).toHaveValue("bug");
  await expect(card.getByRole("radiogroup")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Don't ask me again" })).toHaveCount(0);

  const submit = card.getByRole("button", { name: "Submit" });
  await expect(submit).toBeDisabled();
  await card.getByLabel("Describe the problem you found").fill("   ");
  await expect(submit).toBeDisabled();
  const sent = page.waitForRequest((r) => r.url().includes("/api/me/survey/bug") && r.method() === "POST");
  await card.getByLabel("Describe the problem you found").fill(`E2E bug report ${stamp}`);
  await submit.click();
  const body = (await sent).postDataJSON() as { pagePath: string; fromOffer: boolean };
  expect(body).toMatchObject({ pagePath: "/leaderboard", fromOffer: false });
  await expect(card.getByText("Thanks, we'll look into it.")).toBeVisible();
  await expect(card).toBeHidden({ timeout: 8000 });

  // No cooldown: the button opens again, and the on-demand survey is still on offer.
  await page.reload();
  await page.getByTestId("report-bug").click();
  await expect(card.getByRole("heading", { name: "Report a bug" })).toBeVisible();
  await card.getByRole("button", { name: "Close bug report" }).click();
  await expect(card).toBeHidden();
  await page.locator(".user-trigger").click();
  await expect(page.getByTestId("menu-give-feedback")).toBeVisible();
  await ctx.close();
});

test("from the bug card, another category starts an on-demand survey; afterwards the other categories wait for the cooldown", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Bug Then Survey ${stamp}` });
  const page = await ctx.newPage();
  await page.goto("/");

  await page.getByTestId("report-bug").click();
  const card = page.getByTestId("survey-card");
  await expect(card.getByRole("heading", { name: "Report a bug" })).toBeVisible();
  const started = page.waitForResponse((r) => r.url().includes("/api/me/survey/start") && r.request().method() === "POST");
  await card.getByTestId("survey-topic").selectOption("");
  expect((await started).ok()).toBe(true);
  await expect(card.getByRole("heading", { name: "How are we doing?" })).toBeVisible();
  const overall = card.getByRole("radiogroup", { name: "Overall, how satisfied are you with InnoBox?" });
  await expect(overall).toBeVisible();
  await overall.getByRole("radio", { name: "4 stars" }).click();
  await card.getByRole("button", { name: "Submit" }).click();
  await expect(card.getByText("Thanks — your feedback helps shape InnoBox.")).toBeVisible();
  await expect(card).toBeHidden({ timeout: 8000 });

  await page.reload();
  await page.getByTestId("report-bug").click();
  await expect(card.getByRole("heading", { name: "Report a bug" })).toBeVisible();
  await expect(card.locator('option[value=""]')).toBeDisabled();
  await expect(card.locator('option[value="search"]')).toBeDisabled();
  await expect(card.getByTestId("survey-topic-hint")).toContainText("You can share other feedback again on");
  await ctx.close();
});

test("Give feedback, then Bug: Report a bug mode, and the submit ends the offer", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Feedback Then Bug ${stamp}` });
  const page = await ctx.newPage();
  await page.goto("/");

  await page.locator(".user-trigger").click();
  await page.getByTestId("menu-give-feedback").click();
  const card = page.getByTestId("survey-card");
  await expect(card.getByRole("heading", { name: "How are we doing?" })).toBeVisible();
  await card.getByTestId("survey-topic").selectOption("bug");
  await expect(card.getByRole("heading", { name: "Report a bug" })).toBeVisible();
  await expect(card.getByRole("radiogroup")).toHaveCount(0);
  const sent = page.waitForRequest((r) => r.url().includes("/api/me/survey/bug") && r.method() === "POST");
  await card.getByLabel("Describe the problem you found").fill(`E2E bug from feedback ${stamp}`);
  await card.getByRole("button", { name: "Submit" }).click();
  expect(((await sent).postDataJSON() as { fromOffer: boolean }).fromOffer).toBe(true);
  await expect(card.getByText("Thanks, we'll look into it.")).toBeVisible();

  await page.reload();
  await page.locator(".user-trigger").click();
  await expect(page.getByRole("menuitem", { name: "My profile" })).toBeVisible();
  await expect(page.getByTestId("menu-take-survey")).toHaveCount(0);
  await ctx.close();
});

test("admin: Bug reports as a Source and in the funnel; the Bug reports switch hides the button", async ({ browser }) => {
  // Results lag by a day, so a report sent here is not listed yet; the feed's Bug tag, page path
  // and version are covered by the integration suite with backdated rows.
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Bug Admin ${stamp}`, admin: true });
  const page = await ctx.newPage();
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Survey results" })).toBeVisible();
  await expect(page.getByText(/bug reports? in range/)).toBeVisible();
  await expect(page.getByTestId("survey-funnel-bugs")).toHaveText(/Bug reports: \d+ submitted/);
  await page.getByTestId("survey-source").selectOption("bug");
  await expect(page.getByTestId("survey-source")).toHaveValue("bug");

  const member = await browser.newContext();
  await signIn(member, { name: `E2E Bug Member ${stamp}` });
  const memberPage = await member.newPage();
  await memberPage.goto("/");
  await expect(memberPage.getByTestId("report-bug")).toBeVisible();

  const toggle = page.getByTestId("bug-reports-switch");
  const flip = async () => {
    const saved = page.waitForResponse((r) => r.url().includes("/api/admin/settings") && r.request().method() === "PATCH");
    await toggle.click();
    expect((await saved).ok()).toBe(true);
  };
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await flip();
  try {
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await memberPage.reload();
    // Exact: Home also carries a "See the leaderboard" button, which a substring match would hit.
    await expect(memberPage.getByRole("link", { name: "Leaderboard", exact: true })).toBeVisible();
    await expect(memberPage.getByTestId("report-bug")).toHaveCount(0);
    const refused = await member.request.post("/api/me/survey/bug", {
      data: { description: "x", pagePath: "/", fromOffer: false },
      headers: { "content-type": "application/json", accept: "application/json" },
    });
    expect(refused.status()).toBe(409);
  } finally {
    await flip(); // back on, so the other bug-report specs keep working
  }
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await memberPage.reload();
  await expect(memberPage.getByTestId("report-bug")).toBeVisible();
  await member.close();
  await ctx.close();
});

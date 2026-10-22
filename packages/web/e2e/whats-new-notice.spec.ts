// What's new — the update notice and the page's "New since your last visit" (INNOBOX_SPEC.md
// §13.9). Every persona here seeds its own marker through the dev sign-in seam; an ordinary
// sign-in stamps the running release, so no other spec ever sees the notice.
import { test, expect, type Page } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { CHANGELOG } from "../src/app/whats-new/changelog";
import { UPCOMING } from "@innobox/shared/upcoming";
import { uniqueStamp } from "./helpers/stamp";

const CURRENT = CHANGELOG[0]!;
const PREVIOUS = CHANGELOG[1]!;
const notice = (page: Page) => page.getByTestId("whats-new-notice");

/** The versions rendered as highlighted ("New") rows, in order. */
async function highlightedVersions(page: Page): Promise<string[]> {
  return page.locator(".release-row.is-new").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-version") ?? ""));
}

test("a release below the marker shows the notice; it survives a reload and closes only on ✕", async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Notice Dismiss ${uniqueStamp()}`, whatsNewSeen: PREVIOUS.version });
  const page = await ctx.newPage();
  await page.goto("/");

  await expect(notice(page)).toBeVisible();
  await expect(notice(page)).toContainText("What's new in");
  await expect(notice(page)).toContainText(`v${CURRENT.version}`);
  await expect(notice(page).locator(".update-notice-list li")).toHaveText([CURRENT.summary]);
  await expect(notice(page).getByRole("link")).toHaveText("See what's new");

  // Shown is not acknowledged: a reload brings it back.
  await page.reload();
  await expect(notice(page)).toBeVisible();

  // The body is not a control, and Escape is not a dismissal path.
  await notice(page).locator(".update-notice-list").click();
  await page.keyboard.press("Escape");
  await expect(notice(page)).toBeVisible();

  await notice(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(notice(page)).toHaveCount(0);
  await expect
    .poll(async () => (await (await ctx.request.get("/api/me")).json()).whatsNewSeenVersion)
    .toBe(CURRENT.version);
  await page.reload();
  await expect(page.locator(".user-trigger")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(notice(page)).toHaveCount(0);

  await ctx.close();
});

test("the link lands on the page with exactly the missed entries highlighted above the divider", async ({ browser }) => {
  // Three releases back: three entries missed.
  const seen = CHANGELOG[3]!.version;
  const missed = CHANGELOG.slice(0, 3).map((e) => e.version);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Notice Link ${uniqueStamp()}`, whatsNewSeen: seen });
  const page = await ctx.newPage();
  await page.goto("/");

  const link = notice(page).getByRole("link");
  await expect(link).toHaveText("See what's new since your last visit (3)");
  await link.click();
  // Compare the parsed URL rather than building a regex from the version string.
  await expect(page).toHaveURL((url) => url.pathname === "/whats-new" && url.searchParams.get("since") === seen);
  await expect(notice(page)).toHaveCount(0);

  await expect.poll(() => highlightedVersions(page)).toEqual(missed);
  await expect(page.locator(".release-row.is-new").first()).toContainText("New");
  await expect(page.locator(`.release-row[data-version="${CURRENT.version}"]`)).toContainText("current");
  // The divider sits between the last missed entry and the first older one.
  const divider = page.getByTestId("whats-new-divider");
  await expect(divider).toHaveText("New since your last visit");
  const order = await page.evaluate(() => {
    const divider = document.querySelector('[data-testid="whats-new-divider"]')!;
    const lastNew = [...document.querySelectorAll(".release-row.is-new")].at(-1)!;
    const firstOld = document.querySelector(".release-row:not(.is-new)")!;
    return {
      newBefore: Boolean(lastNew.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING),
      oldAfter: Boolean(divider.compareDocumentPosition(firstOld) & Node.DOCUMENT_POSITION_FOLLOWING),
    };
  });
  expect(order).toEqual({ newBefore: true, oldAfter: true });

  await ctx.close();
});

test("opening the page from the account menu closes the notice and highlights from the marker", async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Notice Menu ${uniqueStamp()}`, whatsNewSeen: CHANGELOG[2]!.version });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(notice(page)).toBeVisible();

  await page.locator(".user-trigger").click();
  await page.getByRole("menuitem", { name: "What's new" }).click();
  await expect(page).toHaveURL(/\/whats-new$/);
  await expect(notice(page)).toHaveCount(0);
  await expect.poll(() => highlightedVersions(page)).toEqual([CURRENT.version, PREVIOUS.version]);

  // The page stamped: the next load is plain.
  await page.reload();
  await expect(page.locator(".release-row").first()).toBeVisible();
  await expect.poll(() => highlightedVersions(page)).toEqual([]);
  await expect(page.getByTestId("whats-new-divider")).toHaveCount(0);

  await ctx.close();
});

test("rollout: a null marker counts and highlights from the boundary date", async ({ browser }) => {
  // The boundary is the date of the third-newest entry: every entry dated on or after it counts.
  const boundary = CHANGELOG[2]!.date;
  const expected = CHANGELOG.filter((e) => e.date >= boundary).map((e) => e.version);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Notice Rollout ${uniqueStamp()}`, whatsNewSeen: "none", whatsNewSinceDate: boundary });
  const page = await ctx.newPage();
  await page.goto("/");

  const label = expected.length === 1 ? "See what's new" : `See what's new since your last visit (${expected.length})`;
  await expect(notice(page).getByRole("link")).toHaveText(label);
  await expect(notice(page).locator(".update-notice-list li")).toHaveCount(Math.min(3, expected.length));
  await notice(page).getByRole("link").click();
  await expect(page).toHaveURL(/\/whats-new\?since=/);
  await expect.poll(() => highlightedVersions(page)).toEqual(expected);

  await ctx.close();
});

for (const viewport of [
  { name: "desktop 1280×600", width: 1280, height: 600 },
  { name: "mobile 390×700", width: 390, height: 700 },
]) {
  test(`overflow at ${viewport.name}: the card fits, the list scrolls, ✕ and link stay visible`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    // Far enough back that three long summaries overflow the 60vh cap.
    await signIn(ctx, { name: `E2E Notice Overflow ${viewport.width} ${uniqueStamp()}`, whatsNewSeen: "0.0.0" });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(notice(page)).toBeVisible();
    // Squeeze the list so it overflows regardless of how long the current summaries are.
    await page.setViewportSize({ width: viewport.width, height: 360 });

    const list = notice(page).locator(".update-notice-list");
    await expect(list).toHaveAttribute("tabindex", "0");
    await expect(list).toHaveAttribute("aria-label", "Release notes");
    // Measure the resting card: mid slide-up it sits up to 16px low, and the mobile sheet has
    // no bottom margin to absorb that.
    await notice(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const box = await notice(page).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(360 + 0.5);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 0.5);
    await expect(notice(page).getByRole("button", { name: "Dismiss" })).toBeInViewport();
    await expect(notice(page).getByRole("link")).toBeInViewport();

    await ctx.close();
  });
}

test("Quick start's Continue leaves no notice behind", async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Notice Onboard ${uniqueStamp()}`, freshOnboarding: true, whatsNewSeen: "none" });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page).toHaveURL(/\/quick-start$/);
  await expect(notice(page)).toHaveCount(0);

  await page.getByRole("button", { name: "Continue to InnoBox" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.reload();
  await expect(page.locator(".user-trigger")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(notice(page)).toHaveCount(0);

  await ctx.close();
});

test("the page opens with Coming soon greyed out above the releases, filtered by role", async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Soon Member ${uniqueStamp()}` });
  const page = await ctx.newPage();
  await page.goto("/whats-new");

  // With no member teaser, whether the section shows depends on the platform-wide feature-ideas
  // switch (§38.11), which another spec may be flipping — so only the teasers are asserted.
  const soon = page.locator("section.soon");
  const everyone = UPCOMING.filter((e) => e.audience === "everyone");
  if (everyone.length > 0) {
    await expect(soon).toBeVisible();
    // Above the releases.
    const above = await page.evaluate(() => {
      const s = document.querySelector("section.soon")!;
      const firstRelease = document.querySelector(".release-row")!;
      return Boolean(s.compareDocumentPosition(firstRelease) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(above).toBe(true);
    await soon.locator(".soon-head").click();
    // Specified teasers only: approved community ideas share the list, and votes set the order (§38.2).
    const titles = await soon.locator('[data-kind="spec"] .soon-name').allTextContents();
    expect([...titles].sort()).toEqual(everyone.map((e) => e.title).sort());
    for (const entry of UPCOMING.filter((e) => e.audience === "platform_admin")) {
      expect(titles).not.toContain(entry.title);
    }
  }

  await ctx.close();
});

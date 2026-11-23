// Innovation board e2e (INNOBOX_SPEC.md §45.10): a platform admin adds a colleague to the board on
// Platform settings; the colleague's bell shows the add notice and their profile says they are on
// the board; an author then submits an organization-wide challenge, having read the board line
// above Submit; the member's bell shows "New challenge … was submitted.", and its link opens the
// challenge while it is still awaiting triage — to read, with no triage control. The board is
// platform-wide, so the spec takes its member off again whatever happens (and runs in the
// platform-state project).
import { test, expect, type Page } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { openNewChallengeForm, submitNewChallenge } from "./helpers/forms";
import { uniqueStamp } from "./helpers/stamp";

const base = () => process.env.E2E_BASE_URL || "http://localhost:3000";

// The admin-override <select> carries every challenge status; `solved` is challenge-only, so it
// identifies the triage control (core-journey.spec.ts uses the same handle).
function challengeStatusSelect(page: Page) {
  return page.locator("select.field").filter({ has: page.locator('option[value="solved"]') });
}

test("innovation board: a member is told of a new challenge and reads it while it awaits triage", async ({ browser }) => {
  const stamp = uniqueStamp();
  const adminName = `E2E Board Admin ${stamp}`;
  const memberName = `E2E Board Member ${stamp}`;
  const adminCtx = await browser.newContext();
  const memberCtx = await browser.newContext();
  const authorCtx = await browser.newContext();
  await signIn(adminCtx, { name: adminName, admin: true });
  const member = await signIn(memberCtx, { name: memberName });
  await signIn(authorCtx, { name: `E2E Board Author ${stamp}` });

  try {
    // ── The platform admin adds the colleague on Platform settings. ──
    const settings = await adminCtx.newPage();
    await settings.goto("/admin/settings");
    const card = settings.getByTestId("innovation-board-card");
    await expect(card).toBeVisible();
    await card.getByLabel("Add people to the innovation board").fill(memberName);
    await settings.locator(".user-result-item").filter({ hasText: memberName }).click();
    await card.getByRole("button", { name: "Add to board" }).click();
    const row = card.getByTestId("innovation-board-row").filter({ hasText: memberName });
    await expect(row).toBeVisible();
    await expect(row).toContainText(`by ${adminName}`);

    // ── The colleague hears about it, and their profile says so. ──
    const page = await memberCtx.newPage();
    await page.goto("/");
    await page.getByRole("button", { name: "Notifications" }).click();
    await expect(page.locator(".msg-panel")).toContainText(`${adminName} added you to the innovation board.`);
    await page.goto("/profile");
    await expect(page.getByTestId("innovation-board-member-line")).toContainText("You're on the innovation board");

    // ── An author submits an organization-wide challenge, having read the board line. ──
    const title = `E2E board challenge ${stamp}`;
    const author = await authorCtx.newPage();
    await openNewChallengeForm(author);
    await expect(author.getByTestId("innovation-board-note")).toHaveText("The innovation board can read this before it's reviewed.");
    await author.locator("#title").fill(title);
    await author.locator("#description").fill("Raised by the innovation board spec.");
    await author.locator("#impactArea").selectOption({ label: "Internal" });
    await submitNewChallenge(author);
    const number = author.url().match(/\/challenges\/(\d+)$/)![1];

    // ── The member's bell carries event 1 in the board's wording; its link opens the challenge. ──
    await page.goto("/");
    await page.getByRole("button", { name: "Notifications" }).click();
    const notice = page.locator(".msg-panel").getByText(`New challenge CH-${number} "${title}" was submitted.`);
    await expect(notice).toBeVisible();
    await notice.click();
    await expect(page).toHaveURL(new RegExp(`/challenges/${number}$`));
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.locator(".pill", { hasText: "Awaiting triage" })).toBeVisible();
    // To read, not to decide: no triage control for a member.
    await expect(challengeStatusSelect(page)).toHaveCount(0);

    // ── Somebody who is not on the board still cannot open it. ──
    const outsiderCtx = await browser.newContext();
    try {
      await signIn(outsiderCtx, { name: `E2E Board Outsider ${stamp}` });
      const res = await outsiderCtx.request.get(`${base()}/api/challenges/${number}`);
      expect(res.status()).toBe(404);
    } finally {
      await outsiderCtx.close();
    }
  } finally {
    await adminCtx.request.delete(`${base()}/api/admin/innovation-board/members/${member.userId}`).catch(() => {});
    await adminCtx.close();
    await memberCtx.close();
    await authorCtx.close();
  }
});

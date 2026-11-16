// Mark as duplicate e2e (INNOBOX_SPEC.md §42.9): a namespace admin (here a platform admin — dev auth
// mints no namespace admin) opens a challenge in review, picks the original in **Mark as duplicate**,
// reads the preview and confirms; the duplicate shows the banner and the closed-comments notice, the
// original shows "Also raised as", a follower of the duplicate now follows the original, and the
// duplicate's author's bell shows "Your challenge CH-… was closed as a duplicate of CH-…".
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, setChallengeStatusViaApi } from "./helpers/api";
import { uniqueStamp } from "./helpers/stamp";

test("mark as duplicate: dialog, preview, banner, closed comments, moved follow, author's bell", async ({ browser }) => {
  test.slow();
  const stamp = uniqueStamp();
  const adminCtx = await browser.newContext();
  const authorCtx = await browser.newContext();
  const followerCtx = await browser.newContext();
  try {
    await signIn(adminCtx, { name: `E2E Dup Admin ${stamp}`, admin: true });
    await signIn(authorCtx, { name: `E2E Dup Author ${stamp}` });
    await signIn(followerCtx, { name: `E2E Dup Follower ${stamp}` });

    const original = await createChallengeViaApi(adminCtx.request, {
      title: `Expense receipts ${stamp} retyped by hand`,
      description: `Every receipt ${stamp} is retyped into the finance tool`,
    });
    await setChallengeStatusViaApi(adminCtx.request, original.digits, "valid");
    const duplicate = await createChallengeViaApi(authorCtx.request, {
      title: `Receipts ${stamp} typed twice`,
      description: `We type each receipt ${stamp} by hand`,
    });
    await setChallengeStatusViaApi(adminCtx.request, duplicate.digits, "in_review");

    // ── A colleague follows the duplicate. ──
    const followerPage = await followerCtx.newPage();
    await followerPage.goto(`/challenges/${duplicate.digits}`);
    await followerPage.getByRole("button", { name: "Follow", exact: true }).click();
    await expect(followerPage.getByRole("button", { name: "Following", exact: true })).toBeVisible();

    // ── The admin marks it from the dialog. ──
    const page = await adminCtx.newPage();
    await page.goto(`/challenges/${duplicate.digits}`);
    await page.getByTestId("mark-duplicate").click();
    const dialog = page.getByTestId("duplicate-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("duplicate-search").fill(`Expense receipts ${stamp}`);
    const candidate = dialog.getByTestId("duplicate-candidate").filter({ hasText: original.number });
    await expect(candidate).toBeVisible();
    await candidate.click();
    const preview = dialog.getByTestId("duplicate-preview");
    await expect(preview).toContainText(`${duplicate.number} closes, and so do its comments.`);
    await expect(preview).toContainText(`will follow ${original.number} instead.`);
    await expect(preview).toContainText("The author is told where the discussion continues.");
    await dialog.getByTestId("duplicate-note").fill("Same receipts problem — the original has the numbers.");
    await dialog.getByTestId("duplicate-confirm").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(`${duplicate.number} marked as a duplicate of ${original.number}.`)).toBeVisible();

    const banner = page.getByTestId("duplicate-banner");
    await expect(banner).toContainText(`Closed as a duplicate of ${original.number}`);
    await expect(banner).toContainText("Same receipts problem — the original has the numbers.");
    await expect(page.getByTestId("comments-closed")).toHaveText(`Comments are closed. The discussion continues on ${original.number}.`);
    await expect(page.getByPlaceholder("Add a comment…")).toHaveCount(0);

    // ── The original lists it. ──
    await banner.getByTestId("duplicate-original-link").click();
    await expect(page).toHaveURL(new RegExp(`/challenges/${original.digits}$`));
    await expect(page.getByTestId("also-raised-as")).toContainText(`Also raised as ${duplicate.number}`);

    // ── The follower now follows the original. ──
    await followerPage.goto(`/challenges/${original.digits}`);
    await expect(followerPage.getByRole("button", { name: "Following", exact: true })).toBeVisible();

    // ── The duplicate's author is told where the discussion continues. ──
    const authorPage = await authorCtx.newPage();
    await authorPage.goto("/");
    await authorPage.getByRole("button", { name: "Notifications" }).click();
    await expect(authorPage.locator(".msg-panel")).toContainText(
      `Your challenge ${duplicate.number} was closed as a duplicate of ${original.number} — the discussion continues there.`,
    );
  } finally {
    await adminCtx.close();
    await authorCtx.close();
    await followerCtx.close();
  }
});

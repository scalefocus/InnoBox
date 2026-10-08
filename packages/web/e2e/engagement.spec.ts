// Engagement e2e (INNOBOX_SPEC.md §10.2 comments, §12/§13 likes & follows): a member raises a
// challenge, then comments (post + owner-edit within the 15-min window), likes, and follows it —
// the everyday social interactions on the detail page. Single persona; all button/form driven
// (no controlled-<select> status changes), so it's reliable under Next dev's route compilation.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";

test("engagement: comment (post + edit), like, and follow a challenge", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Engager ${stamp}` });
  const page = await ctx.newPage();

  // Raise a challenge (its author can comment/like/follow their own visible item).
  await page.goto("/challenges/new");
  await page.locator("#title").fill(`E2E engagement challenge ${stamp}`);
  await page.locator("#description").fill("Something to discuss, like, and follow.");
  await page.locator("#impactArea").selectOption({ label: "Internal" });
  await page.getByRole("button", { name: "Submit challenge" }).click();
  await page.waitForURL(/\/challenges\/\d+$/);

  // ── Comments (§10.2): post, see it, then owner-edit it within the 15-minute window. ──
  const commentBody = `First comment ${stamp}`;
  await page.getByPlaceholder("Add a comment…").fill(commentBody);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(page.getByText(commentBody)).toBeVisible();

  // Scope to the comment list (`.rows`): the challenge itself also has an author-Edit control
  // (§10.1) reading "Edit" in the header, so we must target the comment's Edit, not that one.
  const editedBody = `Edited comment ${stamp}`;
  const commentList = page.locator(".rows");
  await commentList.getByRole("button", { name: "Edit" }).click();
  await commentList.locator("input.field").fill(editedBody); // the inline edit input (no placeholder)
  await commentList.getByRole("button", { name: "Save", exact: true }).click(); // exact → not "Save changes"
  await expect(page.getByText(editedBody)).toBeVisible();
  await expect(commentList.locator(".chip", { hasText: "edited" })).toBeVisible();

  // ── Likes (§13): the like button toggles ♡ 0 → ♥ 1. ──
  const likeBtn = page.locator("button").filter({ hasText: /[♡♥]/ }).first();
  await expect(likeBtn).toContainText("♡");
  await likeBtn.click();
  await expect(likeBtn).toContainText("♥");
  await expect(likeBtn).toContainText("1");

  // ── Follows (§12): the author already auto-follows their own challenge, so test the toggle
  // from that state — "Following" → click → "Follow". ──
  await expect(page.getByRole("button", { name: "Following" })).toBeVisible();
  await page.getByRole("button", { name: "Following" }).click();
  await expect(page.getByRole("button", { name: "Follow", exact: true })).toBeVisible();

  await ctx.close();
});

// Implementation board e2e (INNOBOX_SPEC.md §46). The user-facing flow, end to end through the UI:
//   1. An admin opens Implementation from the sidebar and finds an accepted solution's card in
//      Accepted internally; Move to… → In implementation puts it there, "Less than a day in this stage".
//   2. User B, who has no role, opens the board, sees the card and has no Move to… on it.
//   3. The admin moves it to Implemented: Cancel on the confirmation leaves it where it was; OK moves
//      it, and the challenge's page reads Solved.
//   4. The line under Implemented opens the gallery on Completed; Home's link and Quick start's link
//      both open the board.
// Cards are found by this run's unique challenge title, so other runs' cards never get in the way.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, proposeSolutionViaApi, setChallengeStatusViaApi, setSolutionStatusViaApi } from "./helpers/api";
import { uniqueStamp } from "./helpers/stamp";

test("an admin moves a card across the implementation board and a plain viewer only reads it", async ({ browser }) => {
  const stamp = uniqueStamp();
  const title = `E2E board card ${stamp}`;

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: "E2E Board Admin", admin: true });
  const challenge = await createChallengeViaApi(adminCtx.request, { title, description: "Followed on the implementation board." });
  await setChallengeStatusViaApi(adminCtx.request, challenge.digits, "valid");
  const solution = await proposeSolutionViaApi(adminCtx.request, challenge.digits, { description: "Build it." });
  await setSolutionStatusViaApi(adminCtx.request, solution.digits, "accepted_internally");

  try {
    const page = await adminCtx.newPage();
    await page.goto("/");
    await page.getByRole("link", { name: "Implementation", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Implementation board" })).toBeVisible();

    const column = (status: string) => page.locator(`[data-column="${status}"]`);
    const card = (status: string) => column(status).locator(".impl-card").filter({ hasText: title });
    await expect(card("accepted_internally")).toBeVisible();

    await card("accepted_internally").getByRole("button", { name: "Move to…" }).click();
    await page.getByRole("menuitem", { name: "In implementation" }).click();
    await expect(card("in_implementation")).toBeVisible();
    await expect(card("in_implementation")).toContainText("Less than a day in this stage");

    // User B has no role: the card is there, the menu is not.
    const memberCtx = await browser.newContext();
    await signIn(memberCtx, { name: `E2E Board Member ${stamp}` });
    const member = await memberCtx.newPage();
    await member.goto("/implementation");
    const seen = member.locator('[data-column="in_implementation"] .impl-card').filter({ hasText: title });
    await expect(seen).toBeVisible();
    await expect(seen.getByRole("button", { name: "Move to…" })).toHaveCount(0);
    await memberCtx.close();

    // Cancel at the confirmation leaves the card where it was.
    page.once("dialog", (d) => d.dismiss());
    await card("in_implementation").getByRole("button", { name: "Move to…" }).click();
    await page.getByRole("menuitem", { name: "Implemented" }).click();
    await expect(card("in_implementation")).toBeVisible();

    // OK moves it, and the challenge is solved.
    page.once("dialog", (d) => {
      expect(d.message()).toContain(`This solves ${challenge.number}`);
      void d.accept();
    });
    await card("in_implementation").getByRole("button", { name: "Move to…" }).click();
    await page.getByRole("menuitem", { name: "Implemented" }).click();
    await expect(card("implemented")).toBeVisible();
    await expect(card("implemented")).toContainText("Implemented on");

    await page.goto(`/challenges/${challenge.digits}`);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByText("Solved", { exact: true }).first()).toBeVisible();

    // The line under Implemented opens the gallery on Completed.
    await page.goto("/implementation");
    await column("implemented").getByRole("link", { name: "Challenges → Completed" }).click();
    await expect(page).toHaveURL(/\/challenges\?tab=completed/);
    await expect(page.getByRole("button", { name: "Completed" })).toHaveClass(/active/);

    // Home's link and Quick start's link open the board.
    await page.goto("/");
    await page.getByRole("link", { name: "See the implementation board" }).click();
    await expect(page).toHaveURL(/\/implementation$/);
    await page.goto("/quick-start");
    await page.getByRole("link", { name: "See the implementation board" }).click();
    await expect(page).toHaveURL(/\/implementation$/);
  } finally {
    await adminCtx.close();
  }
});

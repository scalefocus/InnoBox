// Duplicate warning e2e (INNOBOX_SPEC.md §6.1). Submitting a challenge that resembles an existing
// visible one shows an advisory list and flips the button to "Submit anyway"; editing a field
// clears the warning; "Submit anyway" goes through and lands on the new challenge.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, setChallengeStatusViaApi } from "./helpers/api";

test("duplicate warning: similar challenges are suggested, edits re-arm, Submit anyway proceeds", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  // A distinctive word pair so only this run's fixture can match.
  const w1 = `flumox${stamp.replace(/[^a-z]/g, "q")}`;
  const w2 = `gribbly${stamp.replace(/[^a-z]/g, "q")}`;

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Dup Admin ${stamp}`, admin: true });
  const existing = await createChallengeViaApi(adminCtx.request, { title: `Our ${w1} ${w2} keeps failing`, description: "The original." });
  await setChallengeStatusViaApi(adminCtx.request, existing.digits, "valid"); // visible to everyone

  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Dup Member ${stamp}` });
  const page = await ctx.newPage();
  await page.goto("/challenges/new");
  await page.locator("#title").fill(`Fix the ${w1} ${w2} problem`);
  await page.locator("#description").fill("I think this is new.");
  await page.locator("#impactArea").selectOption({ label: "Internal" });

  await page.getByRole("button", { name: "Submit challenge" }).click();
  const warning = page.getByTestId("similar-warning");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(existing.number);
  await expect(page.getByRole("button", { name: "Submit anyway" })).toBeVisible();

  // An edit clears the warning and re-arms the check.
  await page.locator("#description").fill("I think this is new — really.");
  await expect(warning).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Submit challenge" })).toBeVisible();

  // Check again, then submit past it.
  await page.getByRole("button", { name: "Submit challenge" }).click();
  await expect(page.getByTestId("similar-warning")).toBeVisible();
  await page.getByRole("button", { name: "Submit anyway" }).click();
  await expect(page).toHaveURL(/\/challenges\/\d+$/);
  await expect(page.getByRole("heading", { name: `Fix the ${w1} ${w2} problem` })).toBeVisible();

  await ctx.close();
  await adminCtx.close();
});

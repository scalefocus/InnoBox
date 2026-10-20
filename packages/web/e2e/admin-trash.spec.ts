// Platform-admin trash & restore e2e (INNOBOX_SPEC.md §10.4). The user-facing flow, end to end
// through the real UI:
//   1. A member never sees Move to trash, and the trash endpoints answer them 404 (not 403).
//   2. A platform admin moves a challenge to the trash from the danger zone (reason required, no
//      typed number): it is gone from the browse list at once — for its author too, whose detail
//      link now finds nothing — while the admin sees the read-only trashed view under a banner.
//   3. The admin restores it from /admin/trash; it is back in the list exactly as it was.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, setChallengeStatusViaApi } from "./helpers/api";
import { uniqueStamp } from "./helpers/stamp";

test("a member never sees Move to trash, and the trash endpoints answer them 404", async ({ browser }) => {
  const stamp = uniqueStamp();
  const memberCtx = await browser.newContext();
  await signIn(memberCtx, { name: `E2E Trash Member ${stamp}` });
  const challenge = await createChallengeViaApi(memberCtx.request, {
    title: `E2E member-cannot-trash ${stamp}`,
    description: "Raised by a member who must not be able to trash it.",
  });

  const page = await memberCtx.newPage();
  await page.goto(`/challenges/${challenge.digits}`);
  await expect(page.getByRole("heading", { name: `E2E member-cannot-trash ${stamp}` })).toBeVisible();
  await expect(page.getByRole("button", { name: `Move ${challenge.number} to trash` })).toHaveCount(0);

  const headers = { "content-type": "application/json", accept: "application/json" };
  const trash = await memberCtx.request.post(`/api/challenges/${challenge.digits}/trash`, { data: { reason: "mine" }, headers });
  expect(trash.status()).toBe(404);
  const restore = await memberCtx.request.post(`/api/challenges/${challenge.digits}/restore`, { headers });
  expect(restore.status()).toBe(404);
  const list = await memberCtx.request.get("/api/admin/trash", { headers: { accept: "application/json" } });
  expect(list.status()).toBe(404);

  await memberCtx.close();
});

test("move a challenge to the trash, see it gone from the list, restore it from the trash page", async ({ browser }) => {
  const stamp = uniqueStamp();
  const title = `E2E trash-me challenge ${stamp}`;

  const authorCtx = await browser.newContext();
  await signIn(authorCtx, { name: `E2E Trash Author ${stamp}` });
  const challenge = await createChallengeViaApi(authorCtx.request, { title, description: "This challenge is about to take a trip to the trash." });

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: "E2E Trash Admin", admin: true });
  await setChallengeStatusViaApi(adminCtx.request, challenge.digits, "valid");

  // ── Move to trash from the danger zone ───────────────────────────────────────────────
  const page = await adminCtx.newPage();
  await page.goto(`/challenges/${challenge.digits}`);
  await page.getByRole("button", { name: `Move ${challenge.number} to trash` }).click();
  const dialog = page.getByRole("dialog", { name: `Move ${challenge.number} to the trash` });
  const confirm = dialog.getByRole("button", { name: "Move to trash" });
  await expect(confirm).toBeDisabled(); // a reason is required — and nothing else
  await dialog.getByLabel("Reason (required — kept in the audit trail)").fill("posted in the wrong namespace");
  await expect(confirm).toBeEnabled();
  await confirm.click();

  // The admin stays on the read-only trashed view, under the banner.
  const banner = page.getByTestId(`trash-banner-${challenge.number}`);
  await expect(banner).toContainText("This challenge is in the trash. It will be deleted permanently on");
  await expect(banner).toContainText("posted in the wrong namespace");
  await expect(page.getByRole("button", { name: "Follow" })).toHaveCount(0);
  await expect(page.getByPlaceholder("Add a comment…")).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Move ${challenge.number} to trash` })).toHaveCount(0);

  // Gone from the browse list, for the admin and for the author; the author's link finds nothing.
  await page.goto("/challenges");
  await expect(page.getByText(title)).toHaveCount(0);
  const authorPage = await authorCtx.newPage();
  await authorPage.goto("/challenges");
  await expect(authorPage.getByText(title)).toHaveCount(0);
  const hidden = await authorCtx.request.get(`/api/challenges/${challenge.digits}`, { headers: { accept: "application/json" } });
  expect(hidden.status()).toBe(404);

  // ── Restore from /admin/trash ────────────────────────────────────────────────────────
  await page.goto("/admin/trash");
  await expect(page.getByRole("heading", { name: "Trash" })).toBeVisible();
  await page.getByLabel("Filter by number or title").fill(challenge.number);
  const row = page.getByTestId(`trash-row-${challenge.number}`);
  await expect(row).toContainText(title);
  await expect(row).toContainText("posted in the wrong namespace");
  page.once("dialog", (d) => void d.accept());
  await row.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByTestId(`trash-row-${challenge.number}`)).toHaveCount(0);

  // Back where it was, for everyone, with its status untouched.
  const back = await authorCtx.request.get(`/api/challenges/${challenge.digits}`, { headers: { accept: "application/json" } });
  expect(back.status()).toBe(200);
  expect((await back.json()).challenge.status).toBe("valid");
  await authorPage.goto("/challenges");
  await expect(authorPage.getByText(title)).toBeVisible();

  await authorCtx.close();
  await adminCtx.close();
});

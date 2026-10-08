// System banner e2e (INNOBOX_SPEC.md §14.6). A platform admin publishes a banner from the
// Administration console; every signed-in person sees the pill in the header (a plain member
// included); replacing it swaps the text; clearing removes it. Set/clear are platform-admin
// only — a member's direct API call is refused.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";

test("system banner: publish → everyone sees it → replace → clear", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const base = process.env.E2E_BASE_URL || "http://localhost:3000";

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Banner Admin ${stamp}`, admin: true });
  const memberCtx = await browser.newContext();
  await signIn(memberCtx, { name: `E2E Banner Member ${stamp}` });

  // A member cannot set one.
  const refused = await memberCtx.request.put(`${base}/api/admin/system-banner`, {
    data: { message: "nope", duration: "1h" },
    headers: { "content-type": "application/json" },
  });
  expect(refused.status()).toBe(403);

  const admin = await adminCtx.newPage();
  await admin.goto("/admin");
  await expect(admin.getByRole("heading", { name: "Administration" })).toBeVisible();
  const message = `E2E maintenance window ${stamp}`;
  await admin.getByLabel("Banner message").fill(message);
  await admin.getByLabel("Duration").selectOption("1h");
  await admin.getByRole("button", { name: "Publish banner" }).click();
  await expect(admin.getByTestId("banner-active")).toContainText(message);

  // The admin's own header shows it within the poll; the member's too.
  await expect(admin.getByTestId("system-banner")).toContainText(message, { timeout: 45_000 });
  const member = await memberCtx.newPage();
  await member.goto("/challenges");
  await expect(member.getByTestId("system-banner")).toContainText(message, { timeout: 45_000 });

  // Replace: the new text takes over.
  const replaced = `E2E all clear ${stamp}`;
  await admin.getByLabel("Banner message").fill(replaced);
  await admin.getByRole("button", { name: "Replace banner" }).click();
  await expect(admin.getByTestId("banner-active")).toContainText(replaced);

  // Clear: gone from the admin's header and, after its next poll, from the member's.
  await admin.getByRole("button", { name: "Clear now" }).click();
  await expect(admin.getByText("No banner is showing right now.")).toBeVisible();
  await expect(admin.getByTestId("system-banner")).toHaveCount(0, { timeout: 45_000 });
  await member.reload();
  await expect(member.getByTestId("system-banner")).toHaveCount(0, { timeout: 45_000 });

  await adminCtx.close();
  await memberCtx.close();
});

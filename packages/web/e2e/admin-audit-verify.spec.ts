// "Verify integrity" e2e (INNOBOX_SPEC.md §15 hash chain): a platform admin runs the check from
// the audit browser and sees the intact verdict; the run is itself audited as `audit.verified`
// under the Admin chip; a plain member is refused (403) at the API.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";

test("audit integrity: an admin verifies the chain and the run is audited", async ({ browser }) => {
  const stamp = Date.now().toString(36);

  const memberCtx = await browser.newContext();
  await signIn(memberCtx, { name: `E2E Verify Member ${stamp}` });
  const refused = await memberCtx.request.post("/api/admin/audit/verify");
  expect(refused.status()).toBe(403);

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Verify Admin ${stamp}`, admin: true });
  const admin = await adminCtx.newPage();
  await admin.goto("/admin/audit");
  await expect(admin.getByRole("heading", { name: "Audit log" })).toBeVisible();

  await admin.getByRole("button", { name: "Verify integrity" }).click();
  await expect(admin.locator(".audit-verify-status")).toContainText(/Audit log intact — [\d,.\s]+ entries verified \(chain head #\d+\)/, {
    timeout: 30_000,
  });

  // The run is audited (the second audited read) and lands under the Admin chip.
  await admin.getByRole("tab", { name: "Admin" }).click();
  await admin.getByLabel("Search").fill(`E2E Verify Admin ${stamp}`);
  await expect(admin.locator(".rows .row").first().locator(".chip.chip-accent.mono", { hasText: "audit.verified" })).toBeVisible();

  await memberCtx.close();
  await adminCtx.close();
});

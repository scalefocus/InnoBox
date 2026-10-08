// System log e2e (INNOBOX_SPEC.md §14.7). A refused request (a member calling a platform-admin
// endpoint → 403) is recorded with the member as the actor and surfaces on the platform-admin
// system log page; the 403 chip narrows the list; the row expands to its detail; a member is
// locked out of the page itself.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";

test("system log: a member's 403 is recorded and visible to a platform admin", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const base = process.env.E2E_BASE_URL || "http://localhost:3000";

  const memberCtx = await browser.newContext();
  const memberName = `E2E Syslog Member ${stamp}`;
  await signIn(memberCtx, { name: memberName });
  // The refused call: a plain member asking for the audit log is a 403 the log records.
  const refused = await memberCtx.request.get(`${base}/api/admin/audit`, { headers: { accept: "application/json" } });
  expect(refused.status()).toBe(403);

  // The member cannot open the page either.
  const memberPage = await memberCtx.newPage();
  await memberPage.goto("/admin/system-log");
  await expect(memberPage.getByText("The system log is restricted to platform admins.")).toBeVisible();

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Syslog Admin ${stamp}`, admin: true });
  const admin = await adminCtx.newPage();
  await admin.goto("/admin/system-log");
  await expect(admin.getByRole("heading", { name: "System log" })).toBeVisible();

  // Narrow to 403s and to this member, then read the row.
  await admin.getByRole("tab", { name: "403" }).click();
  await admin.getByLabel("Search").fill(memberName);
  const row = admin.locator(".rows .row").first();
  await expect(row.locator(".pill", { hasText: "403" })).toBeVisible();
  await expect(row.getByText("GET /api/admin/audit")).toBeVisible();
  await expect(row.getByRole("button", { name: new RegExp(memberName) })).toBeVisible();

  // Expand → detail shows the route template and the source.
  await row.getByRole("button", { name: /403/ }).first().click();
  await expect(row.locator("dl")).toContainText("/api/admin/audit");
  await expect(row.locator("dl")).toContainText("web");

  await memberCtx.close();
  await adminCtx.close();
});

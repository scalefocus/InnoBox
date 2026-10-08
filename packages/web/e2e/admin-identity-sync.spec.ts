// "Identity sync" card e2e (INNOBOX_SPEC.md §14.10). Covers the user-facing flow: the
// platform-admin gate (no card, API 403 for a member), the card's counts, request times, the
// never-arrived list and its summary chip, and the endpoint's response shape. The namespace-admin
// 403 and the inclusion rules behind each count are asserted at the SQL level instead, in
// api/admin/identity-sync/store.dbtest.ts — the dev sign-in can only mint members and platform
// admins, and the counts depend on SCIM-written rows the e2e stack does not provision.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";

test("identity sync: platform-admin only — a member sees no card and gets 403 from the API", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const memberCtx = await browser.newContext();
  await signIn(memberCtx, { name: `E2E Idsync Member ${stamp}` });

  const page = await memberCtx.newPage();
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Administration is restricted" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Identity sync" })).toHaveCount(0);

  const res = await memberCtx.request.get("/api/admin/identity-sync", { headers: { accept: "application/json" } });
  expect(res.status()).toBe(403);
  await memberCtx.close();
});

test("identity sync: the card shows counts, request times, the never-arrived list and a summary chip", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Idsync Admin ${stamp}`, admin: true });

  const api = await adminCtx.request.get("/api/admin/identity-sync", { headers: { accept: "application/json" } });
  expect(api.status()).toBe(200);
  const body = await api.json();
  expect(Object.keys(body).sort()).toEqual(["groups", "lastRejectedScimRequestAt", "lastScimRequestAt", "state", "unarrivedMappedGroups", "users"]);
  expect(["ok", "nothing_synced", "users_no_groups"]).toContain(body.state);
  expect(typeof body.users.active).toBe("number");
  expect(typeof body.users.deactivated).toBe("number");

  const admin = await adminCtx.newPage();
  await admin.goto("/admin");
  const card = admin.locator(".card", { has: admin.getByRole("heading", { name: "Identity sync" }) });
  await expect(card).toBeVisible();

  for (const label of ["Provisioned users · active", "Provisioned users · deactivated", "Provisioned groups"]) {
    await expect(card.locator(".stat-label", { hasText: label })).toBeVisible();
  }
  await expect(card.getByText("Last SCIM request", { exact: true })).toBeVisible();
  await expect(card.getByText("Last rejected SCIM request", { exact: true })).toBeVisible();
  await expect(card.getByRole("heading", { name: "Mapped groups that never arrived" })).toBeVisible();

  // The collapsed-header chip: "N users · M groups", or "Not synced" when both are zero.
  const users = body.users.active + body.users.deactivated;
  const chip = card.locator(".admin-card-accessory .chip");
  if (users === 0 && body.groups === 0) await expect(chip).toHaveText("Not synced");
  else await expect(chip).toHaveText(/\d+ users? · \d+ groups?/);

  // At most one fixed explanation, and only for the two non-ok states.
  await expect(card.locator(".identity-sync-explain")).toHaveCount(body.state === "ok" ? 0 : 1);

  await adminCtx.close();
});

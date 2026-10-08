// Triage queue e2e (INNOBOX_SPEC.md §13). The admin-facing queue: filtering, tab switching,
// row navigation, and CSV export. Status/bulk controls are controlled <select>s (flaky under Next
// dev-mode — see core-journey.spec.ts) so they're left to the store dbtests; this exercises the
// stable, high-value surface an admin actually drives.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi } from "./helpers/api";

test("triage queue: filter to a challenge by author, navigate to it, and switch tabs", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const memberName = `E2E Queue Member ${stamp}`;
  const title = `E2E triage-queue challenge ${stamp}`;

  // A member raises a challenge — it lands in the queue as `awaiting_triage`.
  const memberCtx = await browser.newContext();
  await signIn(memberCtx, { name: memberName });
  const challenge = await createChallengeViaApi(memberCtx.request, { title, description: "Awaiting an admin." });

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Queue Admin ${stamp}`, admin: true });
  const admin = await adminCtx.newPage();
  await admin.goto("/admin/triage");
  await expect(admin.getByRole("heading", { name: "Triage queue" })).toBeVisible();

  // Both tabs are present; the queue defaults to Challenges.
  await expect(admin.getByRole("button", { name: "Challenges" })).toBeVisible();
  await expect(admin.getByRole("button", { name: "Solutions" })).toBeVisible();

  // Filtering by the (unique) author name narrows the queue to this member's single challenge.
  await admin.getByPlaceholder("Filter by author name").fill(memberName);
  const row = admin.locator(".triage-rows .row-link").filter({ hasText: title });
  await expect(row).toHaveCount(1);

  // The title is a link straight to the detail page.
  await admin.getByRole("link", { name: title }).click();
  await expect(admin).toHaveURL(new RegExp(`/challenges/${challenge.digits}$`));

  // The Solutions tab switches the active queue.
  await admin.goto("/admin/triage");
  await admin.getByRole("button", { name: "Solutions" }).click();
  await expect(admin.getByRole("button", { name: "Solutions" })).toHaveClass(/active/);

  await memberCtx.close();
  await adminCtx.close();
});

test("triage queue: the CSV export is offered and produces a CSV", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Export Admin ${stamp}`, admin: true });
  const admin = await adminCtx.newPage();
  await admin.goto("/admin/triage");

  // The Export CSV affordance is present in the UI…
  await expect(admin.getByRole("button", { name: "Export CSV" })).toBeVisible();

  // …and its endpoint (which the button opens in a new tab) returns a CSV with the header row.
  // Asserting it via the signed-in request jar avoids the window.open/download popup race.
  const res = await adminCtx.request.get("/api/admin/triage/export");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("csv");
  expect(await res.text()).toContain("Number");

  await adminCtx.close();
});

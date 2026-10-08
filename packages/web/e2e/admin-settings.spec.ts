// Platform settings e2e (INNOBOX_SPEC.md §14.3, v0.21.0 impact-area delete). Covers the impact
// areas lifecycle (create → retire → delete, including the reassign-then-delete flow for an area
// that still has challenges), the EU/US date-format toggle, and the platform-admin access gate.
// Settings are platform-admin only — stricter than /admin, which also admits namespace admins.
import { test, expect, type Page, type Locator } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, getImpactAreaId } from "./helpers/api";

// Impact-area rows all share the aria-label "Impact area name" (exact, to exclude the "New impact
// area name" create box), so a row is identified by its input's current value. Poll until a row
// with that value exists (the list re-fetches after each mutation), then return its `.row` parent.
async function impactAreaRow(page: Page, value: string): Promise<Locator> {
  const inputs = page.getByRole("textbox", { name: "Impact area name", exact: true });
  await expect
    .poll(
      async () => {
        const n = await inputs.count();
        for (let i = 0; i < n; i++) if ((await inputs.nth(i).inputValue()) === value) return true;
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    if ((await inputs.nth(i).inputValue()) === value) return inputs.nth(i).locator("xpath=..");
  }
  throw new Error(`impact-area row "${value}" not found`);
}

test("platform settings are refused to a non-platform-admin", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Settings Member ${stamp}` }); // plain member
  const page = await ctx.newPage();
  await page.goto("/admin/settings");
  await expect(page.getByText("You need the platform admin role to view this page.")).toBeVisible();
  await ctx.close();
});

test("impact areas: create, retire, then delete a zero-reference area", async ({ browser }) => {
  test.slow(); // first hit to each of the create/retire/delete impact-area routes compiles cold
  const stamp = Date.now().toString(36);
  const name = `E2E ZeroRef Area ${stamp}`;

  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Settings Admin ${stamp}`, admin: true });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept()); // the Delete confirm
  await page.goto("/admin/settings");
  await expect(page.getByRole("heading", { name: "Platform settings" })).toBeVisible();

  // Create.
  await page.getByPlaceholder("New impact area name").fill(name);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  let row = await impactAreaRow(page, name);
  await expect(row.locator(".pill", { hasText: "Active" })).toBeVisible();

  // Retire (an active area cannot be deleted — it must be retired first).
  await row.getByRole("button", { name: "Retire" }).click();
  row = await impactAreaRow(page, name);
  await expect(row.locator(".pill", { hasText: "Retired" })).toBeVisible();

  // Delete — with zero references there is no reassignment picker; the row disappears.
  await row.getByRole("button", { name: "Delete", exact: true }).click();
  await expect
    .poll(
      async () => {
        const inputs = page.getByRole("textbox", { name: "Impact area name", exact: true });
        const n = await inputs.count();
        for (let i = 0; i < n; i++) if ((await inputs.nth(i).inputValue()) === name) return true;
        return false;
      },
      { timeout: 60_000 }, // absorbs the cold-compile of the DELETE route on its first hit
    )
    .toBe(false);

  await ctx.close();
});

test("impact areas: a retired area with challenges is deleted only after reassignment", async ({ browser }) => {
  test.slow(); // create + submit + retire + delete each may hit a cold-compiled route
  const stamp = Date.now().toString(36);
  const name = `E2E RefArea ${stamp}`;

  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Reassign Admin ${stamp}`, admin: true });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept()); // the Delete confirm
  await page.goto("/admin/settings");

  // Create the area, then file a challenge under it so it has a live reference.
  await page.getByPlaceholder("New impact area name").fill(name);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await impactAreaRow(page, name);
  const areaId = await getImpactAreaId(ctx.request, name);
  await createChallengeViaApi(ctx.request, {
    title: `E2E reassign challenge ${stamp}`,
    description: "Keeps the impact area referenced.",
    impactAreaId: areaId,
  });
  await page.reload(); // pick up the challengeCount

  // Retire it — now a reassignment picker appears and Delete is blocked until a target is chosen.
  let row = await impactAreaRow(page, name);
  await row.getByRole("button", { name: "Retire" }).click();
  row = await impactAreaRow(page, name);
  const reassign = page.getByRole("combobox", { name: `Move challenges from ${name} to` });
  await expect(reassign).toBeVisible();
  const del = row.getByRole("button", { name: "Delete", exact: true });
  await expect(del).toBeDisabled();

  // Pick a target → Delete unlocks; deleting removes the area (its challenges move to the target).
  await reassign.selectOption({ label: "Internal" });
  await expect(del).toBeEnabled();
  await del.click();
  await expect(page.getByRole("combobox", { name: `Move challenges from ${name} to` })).toHaveCount(0);

  await ctx.close();
});

test("date format: switching between EU and US persists across a reload", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E DateFmt Admin ${stamp}`, admin: true });
  const page = await ctx.newPage();
  await page.goto("/admin/settings");

  // Switch to US and confirm it becomes the active (primary) choice, then that it survives a reload.
  await page.getByRole("button", { name: /^US/ }).click();
  await expect(page.getByRole("button", { name: /^US/ })).toHaveClass(/btn-primary/);
  await page.reload();
  await expect(page.getByRole("button", { name: /^US/ })).toHaveClass(/btn-primary/);

  // Switching back to EU proves the toggle works both ways (and restores the default).
  await page.getByRole("button", { name: /^EU/ }).click();
  await expect(page.getByRole("button", { name: /^EU/ })).toHaveClass(/btn-primary/);

  await ctx.close();
});

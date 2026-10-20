// Gamification e2e (INNOBOX_SPEC.md §23.12): with the platform switch on, a solution implemented
// on the author's own challenge → on their next page load the achievement toast celebrates it, the
// Implementer badge shows in their profile's Achievements section, and the event 13 inbox row is in
// the bell. The switch is global, so the spec turns it back off whatever happens.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, proposeSolutionViaApi, setChallengeStatusViaApi, setSolutionStatusViaApi } from "./helpers/api";
import { uniqueStamp } from "./helpers/stamp";

const base = () => process.env.E2E_BASE_URL || "http://localhost:3000";

test("an implemented solution → the author's toast, the profile badge and the inbox row", async ({ browser }) => {
  const stamp = uniqueStamp();
  const adminCtx = await browser.newContext();
  const authorCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Gamification Admin ${stamp}`, admin: true });
  await signIn(authorCtx, { name: `E2E Gamification Author ${stamp}` });

  const setSwitch = (enabled: boolean) =>
    adminCtx.request.patch(`${base()}/api/admin/settings`, { data: { gamificationEnabled: enabled }, headers: { "content-type": "application/json" } });

  try {
    expect((await setSwitch(true)).status()).toBe(200);

    const challenge = await createChallengeViaApi(authorCtx.request, { title: `Gamified ${stamp}`, description: "A challenge that will be solved." });
    await setChallengeStatusViaApi(adminCtx.request, challenge.digits, "valid");
    const solution = await proposeSolutionViaApi(authorCtx.request, challenge.digits, { description: `Own fix ${stamp}` });
    await setSolutionStatusViaApi(adminCtx.request, solution.digits, "implemented");

    const page = await authorCtx.newPage();
    await page.goto("/");
    const toast = page.locator(".toast-achievement");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("Implementer (Bronze)");
    await expect(toast).toContainText("Full Circle");

    await page.goto("/profile");
    const achievements = page.locator(".achievements");
    await expect(achievements.getByRole("heading", { name: "Achievements" })).toBeVisible();
    await expect(achievements.locator(".badge-tile:not(.locked)").filter({ hasText: "Implementer" })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Show my level and badges to others" })).toBeVisible();
    // The toast was acknowledged on the first load — it does not come back.
    await expect(page.locator(".toast-achievement")).toHaveCount(0);

    await page.getByRole("button", { name: "Notifications" }).click();
    await expect(page.locator(".msg-panel")).toContainText("Implementer (Bronze)");
  } finally {
    await setSwitch(false);
    await adminCtx.close();
    await authorCtx.close();
  }
});

// Hype e2e (INNOBOX_SPEC.md §26.11): with hype (and gamification) on, a member hypes a challenge
// from its detail page — the button turns pressed, their bubble joins the hypers list and the budget
// drops to 2 — the item appears on Home's "Hyped this week", the author sees the inbox row, and once
// a solution is implemented (auto-solving the challenge) the hyper's profile shows Talent Scout
// (Bronze). Both switches are global, so the spec turns them back off whatever happens.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, proposeSolutionViaApi, setChallengeStatusViaApi, setSolutionStatusViaApi } from "./helpers/api";

const base = () => process.env.E2E_BASE_URL || "http://localhost:3000";

test("hype: spend one from the detail page, see it on Home, notify the author, earn Talent Scout", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const adminCtx = await browser.newContext();
  const authorCtx = await browser.newContext();
  const fanCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Hype Admin ${stamp}`, admin: true });
  await signIn(authorCtx, { name: `E2E Hype Author ${stamp}` });
  await signIn(fanCtx, { name: `E2E Hype Fan ${stamp}` });

  const setSwitches = (enabled: boolean) =>
    adminCtx.request.patch(`${base()}/api/admin/settings`, {
      data: { hypeEnabled: enabled, gamificationEnabled: enabled },
      headers: { "content-type": "application/json" },
    });

  try {
    expect((await setSwitches(true)).status()).toBe(200);

    const challenge = await createChallengeViaApi(authorCtx.request, { title: `Hyped ${stamp}`, description: "A challenge worth a hype." });
    await setChallengeStatusViaApi(adminCtx.request, challenge.digits, "valid");

    // ── The fan spends a hype from the detail page. ──
    const page = await fanCtx.newPage();
    await page.goto(`/challenges/${challenge.digits}`);
    const hypeBtn = page.getByRole("button", { name: /Hype · 3 left this week/ });
    await expect(hypeBtn).toBeVisible();
    await hypeBtn.click();
    await expect(page.getByRole("button", { name: /Hyped/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("hypers")).toBeVisible();
    // Under a week old, so the hype counts double.
    await expect(page.getByTestId("hype-count").first()).toContainText("2");

    // ── Home: the board lists it, with the budget line. ──
    await page.goto("/");
    const board = page.getByTestId("hyped-this-week");
    await expect(board).toBeVisible();
    await expect(board).toContainText("You have 2 hypes left this week");
    await expect(board.getByTestId("hyped-row").filter({ hasText: `Hyped ${stamp}` })).toBeVisible();

    // ── The author's bell carries the event 16 row. ──
    const authorPage = await authorCtx.newPage();
    await authorPage.goto("/");
    await authorPage.getByRole("button", { name: "Notifications" }).click();
    await expect(authorPage.locator(".msg-panel")).toContainText("hyped your challenge");

    // ── Implementing a solution auto-solves the challenge: the fan earns Talent Scout. ──
    const solution = await proposeSolutionViaApi(authorCtx.request, challenge.digits, { description: `Fix ${stamp}` });
    await setSolutionStatusViaApi(adminCtx.request, solution.digits, "implemented");
    await page.goto("/profile");
    const achievements = page.locator(".achievements");
    await expect(achievements.locator(".badge-tile:not(.locked)").filter({ hasText: "Talent Scout" })).toBeVisible();
  } finally {
    await setSwitches(false);
    await adminCtx.close();
    await authorCtx.close();
    await fanCtx.close();
  }
});

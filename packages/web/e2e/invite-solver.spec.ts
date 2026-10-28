// Invite a solver e2e (INNOBOX_SPEC.md §40.11): on a `valid` challenge user A opens Invite a solver,
// picks user B and writes a note; B's bell shows the invitation and the challenge shows B the banner
// with the note; B proposes from the banner, after which the banner is gone; a reviewer moves the
// solution to `in_review`; A's bell shows "… answered your invitation with SOL-…" and, with
// gamification on, A's profile shows Matchmaker (Bronze). The gamification switch is global, so the
// spec is in the platform-state project and turns it back off whatever happens.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, setChallengeStatusViaApi, setSolutionStatusViaApi } from "./helpers/api";
import { uniqueStamp } from "./helpers/stamp";

const base = () => process.env.E2E_BASE_URL || "http://localhost:3000";

test("invite a solver: invite with a note, the banner, propose from it, the payoff line and Matchmaker", async ({ browser }) => {
  const stamp = uniqueStamp();
  const adminCtx = await browser.newContext();
  const inviterCtx = await browser.newContext();
  const inviteeCtx = await browser.newContext();
  const setSwitch = (enabled: boolean) =>
    adminCtx.request.patch(`${base()}/api/admin/settings`, { data: { gamificationEnabled: enabled }, headers: { "content-type": "application/json" } });
  try {
    await signIn(adminCtx, { name: `E2E Invite Admin ${stamp}`, admin: true });
    const inviterName = `E2E Invite Ana ${stamp}`;
    await signIn(inviterCtx, { name: inviterName });
    const inviteeName = `E2E Invite Bob ${stamp}`;
    await signIn(inviteeCtx, { name: inviteeName });
    expect((await setSwitch(true)).status()).toBe(200);

    const challenge = await createChallengeViaApi(adminCtx.request, { title: `Invite challenge ${stamp}`, description: "Who could crack this?" });
    await setChallengeStatusViaApi(adminCtx.request, challenge.digits, "valid");

    // ── A invites B with a note. ──
    const page = await inviterCtx.newPage();
    await page.goto(`/challenges/${challenge.digits}`);
    await page.getByTestId("invite-solver").click();
    const dialog = page.getByTestId("invite-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("invite-people-field").fill(stamp);
    await dialog.locator(".coauthor-results").getByRole("button", { name: new RegExp(inviteeName) }).click();
    await dialog.getByTestId("invite-note").fill(`You built the cost model last year ${stamp}`);
    await dialog.getByTestId("invite-send").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("Invitation sent")).toBeVisible();

    // ── B's bell and banner. ──
    const inviteePage = await inviteeCtx.newPage();
    await inviteePage.goto("/");
    await inviteePage.getByRole("button", { name: "Notifications" }).click();
    await expect(inviteePage.locator(".msg-panel")).toContainText(`${inviterName} invited you to propose a solution to CH-${challenge.digits}`);
    await inviteePage.goto(`/challenges/${challenge.digits}`);
    const banner = inviteePage.getByTestId("invitation-banner");
    await expect(banner).toContainText(`${inviterName} invited you to propose a solution.`);
    await expect(banner).toContainText(`You built the cost model last year ${stamp}`);

    // ── B proposes from the banner; the banner goes. ──
    await banner.getByTestId("invitation-propose").click();
    await inviteePage.getByLabel("Solution description").fill(`Bob's answer ${stamp}`);
    await inviteePage.getByRole("button", { name: "Submit solution" }).click();
    const row = inviteePage.locator(".row", { hasText: `Bob's answer ${stamp}` });
    await expect(row).toBeVisible();
    await expect(inviteePage.getByTestId("invitation-banner")).toHaveCount(0);
    const solutionNumber = (await row.locator(".chip.mono").first().textContent())!.trim();

    // ── A reviewer moves it out of proposed: the payoff line and the badge. ──
    await setSolutionStatusViaApi(adminCtx.request, solutionNumber.replace("SOL-", ""), "in_review");
    await page.goto("/");
    await page.getByRole("button", { name: "Notifications" }).click();
    await expect(page.locator(".msg-panel")).toContainText(`${inviteeName} answered your invitation with ${solutionNumber}`);
    await page.goto("/profile");
    await expect(page.locator(".achievements .badge-tile:not(.locked)").filter({ hasText: "Matchmaker" })).toBeVisible();
  } finally {
    await setSwitch(false);
    await adminCtx.close();
    await inviterCtx.close();
    await inviteeCtx.close();
  }
});

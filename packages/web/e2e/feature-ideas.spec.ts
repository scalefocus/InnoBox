// Feature ideas e2e (INNOBOX_SPEC.md §38.14): a member proposes an idea from What's new (the thank-you
// shows, the profile lists it as waiting for review); a platform admin sees the console card's
// bubble and approves it with an edited title; the idea appears in Coming soon with "Proposed by" and
// one vote; a second member upvotes it (count 2, their bubble appears), toggles the vote off and on;
// the proposer turns the name switch off and the line disappears; the admin deletes it as shipped and
// the proposer's bell carries "… is now available". With the switch off, the propose button and the
// vote buttons are gone and the profile section is hidden. The switch is global, so the spec turns
// it back on whatever happens.
import { test, expect, type Page } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { uniqueStamp } from "./helpers/stamp";

const base = () => process.env.E2E_BASE_URL || "http://localhost:3000";

/** The Coming soon row whose title is `title`, with the section opened through its fragment. */
async function soonRow(page: Page, title: string) {
  await page.goto("/whats-new#coming-soon");
  await expect(page.locator(".soon-head")).toHaveAttribute("aria-expanded", "true");
  return page.getByTestId("soon-item").filter({ hasText: title });
}

test("feature ideas: propose, approve, upvote, hide the name, ship — and the switch", async ({ browser }) => {
  const stamp = uniqueStamp();
  const adminCtx = await browser.newContext();
  const proposerCtx = await browser.newContext();
  const fanCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Ideas Admin ${stamp}`, admin: true });
  await signIn(proposerCtx, { name: `E2E Ideas Proposer ${stamp}` });
  await signIn(fanCtx, { name: `E2E Ideas Fan ${stamp}` });

  const setSwitch = (enabled: boolean) =>
    adminCtx.request.patch(`${base()}/api/admin/settings`, {
      data: { featureIdeasEnabled: enabled },
      headers: { "content-type": "application/json" },
    });

  try {
    expect((await setSwitch(true)).status()).toBe(200);

    // ── The member proposes from What's new. ──
    const page = await proposerCtx.newPage();
    await page.goto("/whats-new");
    await page.getByTestId("propose-feature").click();
    const dialog = page.getByTestId("propose-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("propose-send")).toBeDisabled();
    await dialog.getByLabel("Your idea").fill(`Idea ${stamp}: let me export the leaderboard as a spreadsheet for the monthly review.`);
    await dialog.getByTestId("propose-send").click();
    await expect(dialog).toContainText("Thanks, a platform admin will review your idea.");
    await dialog.getByRole("button", { name: "Close" }).click();

    await page.goto("/profile");
    const mine = page.getByTestId("profile-idea-list");
    await expect(mine).toContainText("Waiting for review");
    await expect(mine).toContainText(`Idea ${stamp}`);

    // ── The admin approves it with an edited title. ──
    const adminPage = await adminCtx.newPage();
    await adminPage.goto("/admin");
    await expect(adminPage.getByTestId("feature-ideas-card").locator(".nav-badge")).toBeVisible();
    await adminPage.goto("/admin/feature-ideas");
    await adminPage.getByRole("button", { name: new RegExp(`Idea ${stamp}`) }).click();
    await adminPage.getByRole("button", { name: "Approve…" }).click();
    const title = `Leaderboard export ${stamp}`;
    await adminPage.getByLabel("Title").fill(title);
    await adminPage.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(adminPage.locator(".toast")).toContainText("Idea approved");

    // ── It is in Coming soon, credited, with the proposer's own vote. ──
    const fanPage = await fanCtx.newPage();
    let row = await soonRow(fanPage, title);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("soon-proposed-by")).toContainText(`E2E Ideas Proposer ${stamp}`);
    const vote = row.getByTestId("soon-vote");
    await expect(vote).toHaveAttribute("aria-pressed", "false");
    await expect(vote).toContainText("1");

    // ── A second member upvotes, takes it back, and upvotes again. ──
    await vote.click();
    await expect(vote).toHaveAttribute("aria-pressed", "true");
    await expect(vote).toContainText("2");
    await expect(row.getByTestId("soon-voters")).toBeVisible();
    await vote.click();
    await expect(vote).toHaveAttribute("aria-pressed", "false");
    await expect(vote).toContainText("1");
    await vote.click();
    await expect(vote).toContainText("2");

    // ── The proposer hides their name: the line goes, live. ──
    await page.goto("/profile");
    const nameSwitch = page.getByTestId("profile-feature-ideas-named");
    await expect(nameSwitch).toHaveAttribute("aria-checked", "true");
    await nameSwitch.click();
    await expect(nameSwitch).toHaveAttribute("aria-checked", "false");
    row = await soonRow(fanPage, title);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("soon-proposed-by")).toHaveCount(0);

    // ── The admin deletes it as shipped: the proposer hears it is available. ──
    await adminPage.goto("/admin/feature-ideas");
    await adminPage.getByRole("tab", { name: "Planned" }).click();
    await adminPage.getByRole("button", { name: new RegExp(title) }).click();
    await adminPage.getByRole("button", { name: "Delete…" }).click();
    await expect(adminPage.getByTestId("idea-notify-shipped")).toBeChecked();
    await adminPage.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(adminPage.locator(".toast")).toContainText("Idea deleted");
    await page.goto("/");
    await page.getByRole("button", { name: "Notifications" }).click();
    await expect(page.locator(".msg-panel")).toContainText(`${title} is now available`);

    // ── Off: no propose button, no votes, no profile section. ──
    expect((await setSwitch(false)).status()).toBe(200);
    await fanPage.goto("/whats-new");
    await expect(fanPage.getByRole("heading", { name: "What's new" })).toBeVisible();
    await expect(fanPage.getByTestId("propose-feature")).toHaveCount(0);
    await expect(fanPage.getByTestId("soon-vote")).toHaveCount(0);
    await fanPage.goto("/profile");
    await expect(fanPage.getByTestId("profile-feedback")).toBeVisible();
    await expect(fanPage.getByTestId("profile-feature-ideas")).toHaveCount(0);
  } finally {
    await setSwitch(true);
    await adminCtx.close();
    await proposerCtx.close();
    await fanCtx.close();
  }
});

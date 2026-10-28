// Feature ideas e2e (INNOBOX_SPEC.md §38.14): a member proposes an idea with a title from What's new
// (the thank-you shows, the profile lists it under that title as waiting for review); a platform
// admin sees the console card's bubble and the title on the pending row, finds the Approve dialog's
// Title pre-filled with it, and approves it with an edited title; the idea appears in Coming soon with "Proposed by" and
// one vote; a second member upvotes it (count 2, their bubble appears, and it moves above an entry
// with fewer votes), toggles the vote off and on; the proposer turns the name switch off and the line
// disappears; the admin edits another entry's title and What's new shows it; the admin deletes the
// idea as shipped and the proposer's bell carries "… is now available". With proposals closed, a
// member sees no propose button but can still vote, and a platform admin can still propose. The
// switch is global, so the spec turns it back on whatever happens.
import { test, expect, type Page } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { plantComingSoonEntryViaApi, removeComingSoonEntryViaApi } from "./helpers/api";
import { uniqueStamp } from "./helpers/stamp";

const base = () => process.env.E2E_BASE_URL || "http://localhost:3000";

/** The Coming soon row whose title is `title`, with the section opened through its fragment. */
async function soonRow(page: Page, title: string) {
  await page.goto("/whats-new#coming-soon");
  await expect(page.locator(".soon-head")).toHaveAttribute("aria-expanded", "true");
  return page.getByTestId("soon-item").filter({ hasText: title });
}

/** The Coming soon titles in the order the page shows them. */
async function soonTitles(page: Page): Promise<string[]> {
  return page.getByTestId("soon-item").locator(".soon-name").allTextContents();
}

test("feature ideas: propose, approve, upvote, hide the name, edit, ship — and the switch", async ({ browser }) => {
  // Three sign-ins and thirteen page loads across three contexts: the longest journey in the
  // one-worker platform-state chain, past the default 120 s on a loaded dev server.
  test.slow();
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

  const planted: string[] = [];
  try {
    expect((await setSwitch(true)).status()).toBe(200);
    // An entry approved before the idea, with one vote (the planting admin's own): the idea, once it
    // has two, must climb above it.
    const rival = `Rival entry ${stamp}`;
    planted.push(await plantComingSoonEntryViaApi(adminCtx.request, { title: rival }));

    // ── The member proposes from What's new. ──
    const page = await proposerCtx.newPage();
    await page.goto("/whats-new");
    await page.getByTestId("propose-feature").click();
    const dialog = page.getByTestId("propose-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("propose-send")).toBeDisabled();
    const ownTitle = `Spreadsheet export ${stamp}`;
    await dialog.getByLabel("Your idea").fill(`Idea ${stamp}: let me export the leaderboard as a spreadsheet for the monthly review.`);
    await expect(dialog.getByTestId("propose-send")).toBeDisabled();
    await dialog.getByTestId("propose-title-field").fill(ownTitle);
    await dialog.getByTestId("propose-send").click();
    await expect(dialog).toContainText("Thanks, a platform admin will review your idea.");
    await dialog.getByRole("button", { name: "Close" }).click();

    await page.goto("/profile");
    const mine = page.getByTestId("profile-idea-list");
    await expect(mine).toContainText("Waiting for review");
    await expect(mine.locator(".idea-row-title")).toContainText(ownTitle);

    // ── The admin sees the title, finds Approve pre-filled with it, and approves with an edit. ──
    const adminPage = await adminCtx.newPage();
    await adminPage.goto("/admin");
    await expect(adminPage.getByTestId("feature-ideas-card").locator(".nav-badge")).toBeVisible();
    await adminPage.goto("/admin/feature-ideas");
    await adminPage.getByRole("button", { name: new RegExp(ownTitle) }).click();
    await adminPage.getByRole("button", { name: "Approve…" }).click();
    await expect(adminPage.getByLabel("Title")).toHaveValue(ownTitle);
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

    // Tied at one vote, the older approval (the rival) comes first.
    let titles = await soonTitles(fanPage);
    expect(titles.indexOf(rival)).toBeLessThan(titles.indexOf(title));

    // Clicks the vote and resolves once its POST has answered. The optimistic flip renders before
    // the server replies, and while that request is in flight the handler ignores another click on
    // the same entry, so the next click must wait for it: on a loaded dev server the POST takes
    // seconds, and a click fired straight after the flip's assertions is dropped.
    const clickVote = async () => {
      const settled = fanPage.waitForResponse(
        (r) => r.url().endsWith("/api/coming-soon/votes") && r.request().method() === "POST",
      );
      await vote.click();
      return settled;
    };

    // ── A second member upvotes — the idea climbs at once — takes it back, and upvotes again. ──
    let settled = clickVote();
    await expect(vote).toHaveAttribute("aria-pressed", "true");
    await expect(vote).toContainText("2");
    await expect(row.getByTestId("soon-voters")).toBeVisible();
    await expect.poll(async () => {
      titles = await soonTitles(fanPage);
      return titles.indexOf(title) < titles.indexOf(rival);
    }).toBe(true);
    await settled;
    settled = clickVote();
    await expect(vote).toHaveAttribute("aria-pressed", "false");
    await expect(vote).toContainText("1");
    await settled;
    settled = clickVote();
    await expect(vote).toContainText("2");
    await settled;

    // ── The proposer hides their name: the line goes, live. ──
    await page.goto("/profile");
    const nameSwitch = page.getByTestId("profile-feature-ideas-named");
    await expect(nameSwitch).toHaveAttribute("aria-checked", "true");
    await nameSwitch.click();
    await expect(nameSwitch).toHaveAttribute("aria-checked", "false");
    row = await soonRow(fanPage, title);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("soon-proposed-by")).toHaveCount(0);

    // ── The admin edits another entry's title on the Planned tab; What's new shows it. ──
    await adminPage.goto("/admin/feature-ideas");
    await adminPage.getByRole("tab", { name: "Planned" }).click();
    await adminPage.getByRole("button", { name: new RegExp(rival) }).click();
    await adminPage.getByRole("button", { name: "Edit…" }).click();
    const renamed = `Renamed rival ${stamp}`;
    await adminPage.getByLabel("Title").fill(renamed);
    await adminPage.getByRole("button", { name: "Save", exact: true }).click();
    await expect(adminPage.locator(".toast")).toContainText("Entry saved");
    await soonRow(fanPage, renamed);
    await expect(fanPage.getByTestId("soon-item").filter({ hasText: renamed })).toBeVisible();

    // ── The admin deletes the idea as shipped: the proposer hears it is available. ──
    await adminPage.getByRole("button", { name: new RegExp(title) }).click();
    await adminPage.getByRole("button", { name: "Delete…" }).click();
    await expect(adminPage.getByTestId("idea-notify-shipped")).toBeChecked();
    await adminPage.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(adminPage.locator(".toast")).toContainText("Entry deleted");
    await page.goto("/");
    await page.getByRole("button", { name: "Notifications" }).click();
    await expect(page.locator(".msg-panel")).toContainText(`${title} is now available`);

    // ── Proposals closed: a member can no longer propose, but still votes; a platform admin proposes. ──
    expect((await setSwitch(false)).status()).toBe(200);
    const closedRow = await soonRow(fanPage, renamed);
    await expect(fanPage.getByRole("heading", { name: "What's new" })).toBeVisible();
    await expect(fanPage.getByTestId("propose-feature")).toHaveCount(0);
    await expect(closedRow.getByTestId("soon-vote")).toBeVisible();
    await fanPage.goto("/profile");
    await expect(fanPage.getByTestId("profile-feature-ideas")).toBeVisible();
    await adminPage.goto("/whats-new");
    await expect(adminPage.getByTestId("propose-feature")).toBeVisible();
  } finally {
    await setSwitch(true);
    for (const id of planted) await removeComingSoonEntryViaApi(adminCtx.request, id);
    await adminCtx.close();
    await proposerCtx.close();
    await fanCtx.close();
  }
});

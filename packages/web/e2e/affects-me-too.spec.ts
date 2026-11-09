// "This affects me too" e2e (INNOBOX_SPEC.md §41.10): user B opens a challenge in review and marks
// it with 12 — the button reads "Affects me · 12", B's chip appears, the reach rises by 12 and B
// follows the challenge; the author's bell shows "B says CH-… affects them too"; in the triage queue
// the admin sorts by Reach and the challenge moves up. On the submit form, user C, whose draft
// matches the challenge, marks it from the similar-challenges banner and sees the toast.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, setChallengeStatusViaApi } from "./helpers/api";
import { uniqueStamp } from "./helpers/stamp";

test("affects me too: mark with a headcount, the author's bell, the triage Reach sort, the similar banner", async ({ browser }) => {
  const stamp = uniqueStamp();
  const adminCtx = await browser.newContext();
  const markerCtx = await browser.newContext();
  const drafterCtx = await browser.newContext();
  try {
    await signIn(adminCtx, { name: `E2E Affected Admin ${stamp}`, admin: true });
    const markerName = `E2E Affected Bob ${stamp}`;
    await signIn(markerCtx, { name: markerName });
    await signIn(drafterCtx, { name: `E2E Affected Cy ${stamp}` });

    // The admin authors both, so the triage author filter narrows the queue to this spec's two.
    const wide = await createChallengeViaApi(adminCtx.request, {
      title: `Printers ${stamp} jam every morning`,
      description: `The ${stamp} printers on every floor jam each morning`,
      affectedEstimate: 30,
    });
    await setChallengeStatusViaApi(adminCtx.request, wide.digits, "in_review");
    const newer = await createChallengeViaApi(adminCtx.request, { title: `Desk booking ${stamp}`, description: "A smaller problem" });
    await setChallengeStatusViaApi(adminCtx.request, newer.digits, "in_review");

    // ── B marks the challenge with 12. ──
    const page = await markerCtx.newPage();
    await page.goto(`/challenges/${wide.digits}`);
    await expect(page.getByTestId("reach")).toHaveText("About 30 people affected");
    await page.getByTestId("affected-button").click();
    const popover = page.getByTestId("affected-popover");
    await expect(popover).toBeVisible();
    await popover.getByRole("spinbutton").fill("12");
    await popover.getByRole("button", { name: "Add" }).click();
    await expect(popover).toHaveCount(0);
    await expect(page.getByTestId("affected-button")).toHaveText(/Affects me · 12/);
    await expect(page.getByTestId("reach")).toHaveText("About 42 people affected");
    await expect(page.getByTestId("affected-chip").filter({ hasText: markerName })).toContainText("· 12");
    await expect(page.getByTestId("affected-breakdown")).toHaveText("The author's estimate of 30, plus 1 colleague who says it affects them too.");
    await expect(page.getByRole("button", { name: "Following" })).toBeVisible();

    // ── The author's bell. ──
    const adminPage = await adminCtx.newPage();
    await adminPage.goto("/");
    await adminPage.getByRole("button", { name: "Notifications" }).click();
    await expect(adminPage.locator(".msg-panel")).toContainText(`${markerName} says CH-${wide.digits} affects them too`);

    // ── Triage: newest first by default; the Reach header puts the widest first. ──
    await adminPage.goto("/admin/triage");
    await adminPage.getByPlaceholder("Filter by author name").fill(`E2E Affected Admin ${stamp}`);
    const rows = adminPage.locator(".triage-rows .row-link");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText(`Desk booking ${stamp}`);
    await adminPage.getByTestId("triage-sort-reach").click();
    await expect(rows.first()).toContainText(`Printers ${stamp} jam every morning`);
    await expect(rows.first().getByTestId("reach-count")).toContainText("42");

    // ── C's draft matches: mark it from the similar-challenges banner instead. ──
    const draft = await drafterCtx.newPage();
    await draft.goto("/challenges/new");
    await draft.locator("#title").fill(`Printers ${stamp} jam every morning again`);
    await draft.locator("#description").fill(`The ${stamp} printers jam each morning on my floor`);
    await draft.locator("#impactArea").selectOption({ label: "Internal" });
    await draft.getByRole("button", { name: "Submit challenge" }).click();
    const warning = draft.getByTestId("similar-warning");
    await expect(warning).toBeVisible();
    const match = warning.locator("li", { hasText: `CH-${wide.digits}` });
    await match.getByTestId("affected-button").click();
    await match.getByTestId("affected-popover").getByRole("button", { name: "Add" }).click();
    await expect(draft.getByText(`Marked CH-${wide.digits} as affecting you. You can still submit yours.`)).toBeVisible();
    await expect(match.getByTestId("affected-button")).toHaveText(/Affects me · 1/);
    await expect(draft.getByRole("button", { name: "Submit anyway" })).toBeVisible();
  } finally {
    await adminCtx.close();
    await markerCtx.close();
    await drafterCtx.close();
  }
});

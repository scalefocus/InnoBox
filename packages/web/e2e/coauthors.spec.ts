// Co-authors e2e (INNOBOX_SPEC.md §39.13): a member proposes a solution with a co-author picked in
// the propose form; the co-author's bell carries "… added you as a co-author of SOL-n", they open the
// item, edit the solution from the shared author controls and leave it from the Team panel — after
// which the proposed solution is hidden from them again. A challenge submitted with a co-author
// appears under the co-author's Mine tab.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, setChallengeStatusViaApi } from "./helpers/api";
import { uniqueStamp } from "./helpers/stamp";

test("co-authors: propose with a co-author, who is told, edits the solution and leaves the team", async ({ browser }) => {
  const stamp = uniqueStamp();
  const adminCtx = await browser.newContext();
  const authorCtx = await browser.newContext();
  const partnerCtx = await browser.newContext();
  try {
    await signIn(adminCtx, { name: `E2E Team Admin ${stamp}`, admin: true });
    await signIn(authorCtx, { name: `E2E Team Author ${stamp}` });
    const partnerName = `E2E Team Partner ${stamp}`;
    const partner = await signIn(partnerCtx, { name: partnerName });

    // ── A challenge submitted with a co-author: it is under the co-author's Mine tab. ──
    const challenge = await createChallengeViaApi(authorCtx.request, {
      title: `Team challenge ${stamp}`,
      description: "Spotted together.",
      coAuthorIds: [partner.userId],
    });
    const partnerPage = await partnerCtx.newPage();
    await partnerPage.goto("/challenges");
    await partnerPage.getByRole("button", { name: "Mine", exact: true }).click();
    await expect(partnerPage.getByText(`Team challenge ${stamp}`).first()).toBeVisible();
    await setChallengeStatusViaApi(adminCtx.request, challenge.digits, "valid");

    // ── The author proposes a solution, picking the partner in the co-author field. ──
    const page = await authorCtx.newPage();
    await page.goto(`/challenges/${challenge.digits}`);
    await page.getByRole("button", { name: "Propose a solution" }).click();
    await page.getByLabel("Solution description").fill(`Our joint idea ${stamp}`);
    await page.getByLabel("Co-authors (optional)").fill(stamp);
    await page.locator(".coauthor-results").getByRole("button", { name: new RegExp(partnerName) }).click();
    // Co-authors and anonymity exclude each other (§39.3).
    await expect(page.getByRole("checkbox", { name: /Submit anonymously/ })).toBeDisabled();
    await page.getByRole("button", { name: "Submit solution" }).click();
    const solutionRow = page.locator(".row", { hasText: `Our joint idea ${stamp}` });
    await expect(solutionRow).toBeVisible();
    const solutionNumber = (await solutionRow.locator(".chip.mono").first().textContent())!.trim();

    // ── The partner's bell carries event 21. ──
    await partnerPage.goto("/");
    await partnerPage.getByRole("button", { name: "Notifications" }).click();
    await expect(partnerPage.locator(".msg-panel")).toContainText(`added you as a co-author of ${solutionNumber}`);

    // ── The partner edits the solution and sees the Team panel. ──
    await partnerPage.goto(`/challenges/${challenge.digits}#${solutionNumber}`);
    const row = partnerPage.locator(`[id="${solutionNumber}"]`);
    const team = partnerPage.getByTestId(`team-panel-${solutionNumber}`);
    await expect(team).toContainText(partnerName);
    await expect(team).toContainText("Creator");
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    await row.locator("textarea").first().fill(`Our joint idea, refined ${stamp}`);
    await row.getByRole("button", { name: "Save changes" }).click();
    await expect(row).toContainText(`Our joint idea, refined ${stamp}`);

    // ── Leaving: final, and a proposed solution is hidden from non-members again. ──
    partnerPage.on("dialog", (dialog) => void dialog.accept());
    await team.getByRole("button", { name: "Leave" }).click();
    await expect(partnerPage.locator(`[id="${solutionNumber}"]`)).toHaveCount(0);
  } finally {
    await adminCtx.close();
    await authorCtx.close();
    await partnerCtx.close();
  }
});

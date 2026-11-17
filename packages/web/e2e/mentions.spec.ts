// Mentions e2e (INNOBOX_SPEC.md §43.11): on a `valid` challenge user A opens Propose a solution, types
// `@` and the start of user B's name, picks B from the list and sees B's chip in the Mentioned row; A
// submits; B's bell shows nothing yet — a `proposed` solution is hidden from them; a reviewer moves
// the solution to `in_review`; B's bell shows "… mentioned you in SOL-…", and the link opens the
// challenge at that solution, where B's name is a link that opens the directory card.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, setChallengeStatusViaApi, setSolutionStatusViaApi } from "./helpers/api";
import { uniqueStamp } from "./helpers/stamp";

test("mentions: pick a colleague with @, the Mentioned row, told once the solution leaves proposed, the linked name", async ({ browser }) => {
  test.slow(); // three personas and a cold-compiled detail page
  const stamp = uniqueStamp();
  const adminCtx = await browser.newContext();
  const authorCtx = await browser.newContext();
  const mentionedCtx = await browser.newContext();
  try {
    await signIn(adminCtx, { name: `E2E Mention Admin ${stamp}`, admin: true });
    const authorName = `E2E Mention Ana ${stamp}`;
    await signIn(authorCtx, { name: authorName });
    const mentionedName = `E2E Mention Bob ${stamp}`;
    await signIn(mentionedCtx, { name: mentionedName });

    const challenge = await createChallengeViaApi(adminCtx.request, { title: `Mention challenge ${stamp}`, description: "Who owns the system this touches?" });
    await setChallengeStatusViaApi(adminCtx.request, challenge.digits, "valid");

    // ── A types @ and picks B from the list; the Mentioned row shows B's chip. ──
    const page = await authorCtx.newPage();
    await page.goto(`/challenges/${challenge.digits}`);
    await page.getByRole("button", { name: "Propose a solution", exact: true }).click();
    const box = page.getByLabel("Solution description");
    await box.fill(`Mention answer ${stamp}, check with @Bob ${stamp}`);
    await page.getByRole("option", { name: new RegExp(mentionedName) }).click();
    await expect(box).toHaveValue(`Mention answer ${stamp}, check with @${mentionedName} `);
    const row = page.getByTestId("mentioned-row");
    await expect(row).toContainText(mentionedName);
    await expect(row).toContainText("They'll be told once they can see this solution");
    await page.getByRole("button", { name: "Submit solution" }).click();
    const solution = page.locator(".row", { hasText: `Mention answer ${stamp}` });
    await expect(solution).toBeVisible();
    const solutionNumber = (await solution.locator(".chip.mono").first().textContent())!.trim();
    // The author sees the mention as a link on their own (still proposed) solution.
    await expect(solution.locator("a.mention")).toHaveText(`@${mentionedName}`);

    // ── B is not told while the solution is proposed. ──
    const mentionedPage = await mentionedCtx.newPage();
    await mentionedPage.goto("/");
    await mentionedPage.getByRole("button", { name: "Notifications" }).click();
    await expect(mentionedPage.locator(".msg-panel")).not.toContainText("mentioned you");

    // ── A reviewer takes it out of proposed: B is told, and the link opens the solution. ──
    await setSolutionStatusViaApi(adminCtx.request, solutionNumber.replace("SOL-", ""), "in_review");
    await mentionedPage.goto("/");
    await mentionedPage.getByRole("button", { name: "Notifications" }).click();
    const notice = mentionedPage.locator(".msg-panel").getByText(`${authorName} mentioned you in ${solutionNumber}`);
    await expect(notice).toBeVisible();
    await notice.click();
    await expect(mentionedPage).toHaveURL(new RegExp(`/challenges/${challenge.digits}#${solutionNumber}$`));
    const name = mentionedPage.locator("a.mention", { hasText: `@${mentionedName}` });
    await expect(name).toBeVisible();
    await name.hover();
    await expect(mentionedPage.locator(".dir-card")).toContainText(mentionedName);
  } finally {
    await adminCtx.close();
    await authorCtx.close();
    await mentionedCtx.close();
  }
});

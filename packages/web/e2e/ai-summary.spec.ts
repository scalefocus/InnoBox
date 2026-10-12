// Discussion summary e2e (INNOBOX_SPEC.md §22.13), against a local provider stub: the "Summarize
// discussion" control appears once a thread holds 10 visible comments; the summary shows headed
// "Summary by …" and "May be inaccurate."; the prompt carries pseudonyms, never names; a new
// comment marks it stale with Refresh. Self-skips without AI_TOKEN_ENC_KEY on the server.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi } from "./helpers/api";
import { aiKeyPresent, disableAiStub, enableAiStub, startAiStub } from "./helpers/ai-stub";

test("discussion summary: summarize a long thread, then it goes stale", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const base = process.env.E2E_BASE_URL || "http://localhost:3000";

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E AI Summary Admin ${stamp}`, admin: true });
  test.skip(!(await aiKeyPresent(adminCtx.request, base)), "the server has no AI_TOKEN_ENC_KEY");

  const stub = await startAiStub((call) =>
    call.system.includes("DISCUSSION") ? JSON.stringify({ summary: "The thread agrees on an OCR pilot.", openQuestions: ["Who funds it?"] }) : "{}",
  );
  try {
    await enableAiStub(adminCtx.request, base, stub, { features: { discussion_summary: true } });

    const authorName = `E2E AI Summary Author ${stamp}`;
    const authorCtx = await browser.newContext();
    await signIn(authorCtx, { name: authorName });
    const ch = await createChallengeViaApi(authorCtx.request, { title: `Summary thread ${stamp}`, description: "A long discussion." });
    const post = (body: string) =>
      authorCtx.request.post(`${base}/api/comments`, { data: { parentType: "challenge", parentId: ch.id, body }, headers: { "content-type": "application/json" } });
    for (let i = 0; i < 9; i++) expect((await post(`point ${i}`)).status()).toBe(201);

    const page = await authorCtx.newPage();
    await page.goto(`/challenges/${ch.digits}`);
    await expect(page.getByText("point 8")).toBeVisible();
    await expect(page.getByRole("button", { name: /Summarize discussion/ })).toHaveCount(0);

    expect((await post("point 9")).status()).toBe(201);
    await page.reload();
    await page.getByRole("button", { name: /Summarize discussion \(10 comments\)/ }).click();
    const panel = page.getByTestId("discussion-summary");
    await expect(panel).toContainText("Summary by");
    await expect(panel).toContainText("May be inaccurate.");
    await expect(panel).toContainText("The thread agrees on an OCR pilot.");
    const sent = stub.calls.at(-1)!.user;
    expect(sent).toContain("Participant A: point 0");
    expect(sent).not.toContain(authorName);

    // A new comment makes it stale.
    await page.getByPlaceholder("Add a comment…").fill("point 10");
    await page.getByPlaceholder("Add a comment…").press("Enter");
    await expect(panel).toContainText("New comments since this summary");
    await expect(panel.getByRole("button", { name: "Refresh" })).toBeVisible();

    await authorCtx.close();
  } finally {
    await disableAiStub(adminCtx.request, base, ["discussion_summary"]);
    await stub.close();
    await adminCtx.close();
  }
});

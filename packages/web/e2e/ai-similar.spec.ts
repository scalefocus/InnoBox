// "Similar challenges, explained" e2e (INNOBOX_SPEC.md §22.12), against a local provider stub: with
// the switch on, the §6.1 duplicate banner shows a one-line reason under each match; with it off,
// the plain banner returns. Self-skips without AI_TOKEN_ENC_KEY on the server.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { openNewChallengeForm } from "./helpers/forms";
import { createChallengeViaApi } from "./helpers/api";
import { aiKeyPresent, disableAiStub, enableAiStub, startAiStub } from "./helpers/ai-stub";

test("similar challenges, explained: reasons in the duplicate banner", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const base = process.env.E2E_BASE_URL || "http://localhost:3000";

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E AI Similar Admin ${stamp}`, admin: true });
  test.skip(!(await aiKeyPresent(adminCtx.request, base)), "the server has no AI_TOKEN_ENC_KEY");

  const stub = await startAiStub((call) => {
    if (!call.system.includes("SIMILAR")) return "{}";
    const nums = [...call.user.matchAll(/^#(\d+)/gm)].map((m) => Number(m[1]));
    return JSON.stringify({ ranking: nums.map((n) => ({ number: n, reason: `Same problem: manual invoice matching (${n})` })) });
  });
  try {
    await enableAiStub(adminCtx.request, base, stub, { features: { duplicate_explain: true } });

    const authorCtx = await browser.newContext();
    await signIn(authorCtx, { name: `E2E AI Similar Author ${stamp}` });
    const word = `qz${stamp}`;
    await createChallengeViaApi(authorCtx.request, { title: `${word} invoice matching by hand`, description: `${word} invoices are matched by hand.` });

    const page = await authorCtx.newPage();
    await openNewChallengeForm(page);
    await page.locator("#title").fill(`${word} invoice matching`);
    await page.locator("#description").fill(`${word} invoices matched manually`);
    await page.locator("#impactArea").selectOption({ label: "Internal" });
    await page.getByRole("button", { name: "Submit challenge" }).click();

    const banner = page.getByTestId("similar-warning");
    await expect(banner).toBeVisible();
    await expect(banner.getByTestId("similar-reason").first()).toContainText("Same problem: manual invoice matching");
    await expect(banner).toContainText("Reasons suggested by");

    // Switch off → the plain banner (edit to re-arm the check, then check again).
    await adminCtx.request.put(`${base}/api/admin/ai/switches`, { data: { features: { duplicate_explain: false } }, headers: { "content-type": "application/json" } });
    await page.locator("#description").fill(`${word} invoices matched manually, again`);
    await page.getByRole("button", { name: "Submit challenge" }).click();
    await expect(banner).toBeVisible();
    await expect(banner.getByTestId("similar-reason")).toHaveCount(0);

    await authorCtx.close();
  } finally {
    await disableAiStub(adminCtx.request, base, ["duplicate_explain"]);
    await stub.close();
    await adminCtx.close();
  }
});

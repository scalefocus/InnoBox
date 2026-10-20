// Improve with AI e2e (INNOBOX_SPEC.md §22.10), against a local provider stub: an author improves
// a challenge draft — confirm-before-replace (the fields hold text), the fields are replaced and
// the impact-area hint can be applied, Undo restores the pre-draft text, editing a drafted field
// retires Undo, and a draft fill re-arms the duplicate check like any edit. Self-skips without
// AI_TOKEN_ENC_KEY on the server.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi } from "./helpers/api";
import { aiKeyPresent, disableAiStub, enableAiStub, startAiStub } from "./helpers/ai-stub";
import { uniqueStamp } from "./helpers/stamp";

test("Improve with AI: confirm, replace, hint, undo, duplicate check re-armed", async ({ browser }) => {
  const stamp = uniqueStamp();
  const base = process.env.E2E_BASE_URL || "http://localhost:3000";

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E AI Draft Admin ${stamp}`, admin: true });
  test.skip(!(await aiKeyPresent(adminCtx.request, base)), "the server has no AI_TOKEN_ENC_KEY");

  const draftedTitle = `Manual invoice matching in finance ${stamp}`;
  const stub = await startAiStub((call) =>
    call.system.includes("challenge (a problem worth solving)")
      ? JSON.stringify({ title: draftedTitle, description: "Problem\nInvoices are matched by hand.", impactArea: "Accelerator" })
      : "{}",
  );
  try {
    await enableAiStub(adminCtx.request, base, stub);

    const authorCtx = await browser.newContext();
    await signIn(authorCtx, { name: `E2E AI Draft Author ${stamp}` });
    // An earlier challenge of this author's that the drafted text will look similar to.
    await createChallengeViaApi(authorCtx.request, { title: draftedTitle, description: "Invoices are matched by hand in finance." });

    const page = await authorCtx.newPage();
    await page.goto("/challenges/new");
    const title = page.locator("#title");
    const description = page.locator("#description");
    await title.fill(`invoice stuff ${stamp}`);
    await description.fill("we do invoices by hand");
    const improve = page.getByRole("button", { name: /Improve with/ });
    await expect(improve).toBeVisible();

    // Confirm-before-replace: nothing is sent until a choice is made.
    await improve.click();
    await expect(page.getByRole("dialog")).toContainText("Some fields already have text");
    expect(stub.calls.length).toBe(0);
    await page.getByRole("button", { name: "Replace" }).click();
    await expect(title).toHaveValue(draftedTitle);
    await expect(description).toHaveValue("Problem\nInvoices are matched by hand.");
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0]!.user).not.toContain("E2E AI Draft Author");

    // The impact-area hint is applied only on request.
    const hint = page.getByTestId("ai-draft-hint");
    await expect(hint).toContainText("Accelerator");
    await hint.getByRole("button", { name: "Apply" }).click();
    await expect(page.locator("#impactArea option:checked")).toHaveText("Accelerator");

    // Undo restores the pre-draft text.
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(title).toHaveValue(`invoice stuff ${stamp}`);
    await expect(description).toHaveValue("we do invoices by hand");
    await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);

    // Draft again; editing a drafted field retires Undo.
    await improve.click();
    await page.getByRole("button", { name: "Replace" }).click();
    await expect(title).toHaveValue(draftedTitle);
    await description.fill("Problem\nInvoices are matched by hand. Edited.");
    await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);

    // The duplicate check: first Submit warns about the similar earlier challenge…
    await page.getByRole("button", { name: "Submit challenge" }).click();
    await expect(page.getByTestId("similar-warning")).toBeVisible();
    // …and a draft fill counts as an edit: the warning clears and the next click re-checks.
    await improve.click();
    await page.getByRole("button", { name: "Replace" }).click();
    await expect(page.getByTestId("similar-warning")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Submit challenge" })).toBeVisible();

    await authorCtx.close();
  } finally {
    await disableAiStub(adminCtx.request, base);
    await stub.close();
    await adminCtx.close();
  }
});

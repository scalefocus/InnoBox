// Triage assist e2e (INNOBOX_SPEC.md §22.11), against a local provider stub. The e2e environment
// runs no worker, so the note itself (written by the worker's pass) is covered by the worker's
// live-DB suite; here: with the switch on, a namespace admin sees the "… triage notes" panel as
// Pending on a new challenge and the queue row shows the indicator, while the author never sees
// the panel. With the switch off the panel is gone. Self-skips without AI_TOKEN_ENC_KEY.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi } from "./helpers/api";
import { aiKeyPresent, disableAiStub, enableAiStub, startAiStub } from "./helpers/ai-stub";

test("triage assist: admins see the pending note and the queue indicator; the author never does", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const base = process.env.E2E_BASE_URL || "http://localhost:3000";

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E AI Triage Admin ${stamp}`, admin: true });
  test.skip(!(await aiKeyPresent(adminCtx.request, base)), "the server has no AI_TOKEN_ENC_KEY");

  const stub = await startAiStub(() => "{}");
  try {
    await enableAiStub(adminCtx.request, base, stub, { features: { triage_assist: true } });

    const authorCtx = await browser.newContext();
    await signIn(authorCtx, { name: `E2E AI Triage Author ${stamp}` });
    const created = await createChallengeViaApi(authorCtx.request, { title: `Triage assist subject ${stamp}`, description: "Invoices are matched by hand." });
    const digits = created.number.replace("CH-", "");

    // The author: no panel, and the API answers 404.
    const authorPage = await authorCtx.newPage();
    await authorPage.goto(`/challenges/${digits}`);
    await expect(authorPage.getByRole("heading", { name: `Triage assist subject ${stamp}` })).toBeVisible();
    await expect(authorPage.getByTestId("triage-notes")).toHaveCount(0);
    expect((await authorCtx.request.get(`${base}/api/ai/triage/${digits}`)).status()).toBe(404);

    // The admin: the panel, pending (no worker here), no Re-run while pending.
    const admin = await adminCtx.newPage();
    await admin.goto(`/challenges/${digits}`);
    const panel = admin.getByTestId("triage-notes");
    await expect(panel).toContainText("triage notes");
    await expect(panel).toContainText("Pending");
    await expect(panel.getByRole("button", { name: "Re-run" })).toHaveCount(0);

    // The queue row carries the indicator.
    const queue = await adminCtx.request.get(`${base}/api/admin/triage?number=${digits}`);
    const rows = ((await queue.json()) as { rows: { number: string; aiNotes: string | null }[] }).rows;
    expect(rows.find((r) => r.number === created.number)?.aiNotes).toBe("pending");

    // Switch off → nothing to show.
    await adminCtx.request.put(`${base}/api/admin/ai/switches`, { data: { features: { triage_assist: false } }, headers: { "content-type": "application/json" } });
    expect((await adminCtx.request.get(`${base}/api/ai/triage/${digits}`)).status()).toBe(404);

    await authorCtx.close();
  } finally {
    await disableAiStub(adminCtx.request, base, ["triage_assist"]);
    await stub.close();
    await adminCtx.close();
  }
});

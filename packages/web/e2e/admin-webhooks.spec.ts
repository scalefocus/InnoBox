// Channel webhooks e2e (INNOBOX_SPEC.md §12.4). The Administration card lists every namespace
// with its webhooks; the API is platform-admin only (a member is refused 403). When the server
// has WEBHOOK_ENC_KEY, an admin adds a webhook (URL shown only as its hint), switches it off with
// the preference pill, edits it with the URL left empty (kept), and deletes it. Without the key
// the card says webhooks are not configured and a create is refused 409. The URL used is a
// public IP literal, so saving needs no DNS; no Send test is run (it would leave the machine).
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";

test("channel webhooks: platform-admin only; add → hint only → switch off → edit keeps URL → delete", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const base = process.env.E2E_BASE_URL || "http://localhost:3000";

  const memberCtx = await browser.newContext();
  await signIn(memberCtx, { name: `E2E Webhook Member ${stamp}` });
  expect((await memberCtx.request.get(`${base}/api/admin/webhooks`)).status()).toBe(403);

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Webhook Admin ${stamp}`, admin: true });
  const listed = await adminCtx.request.get(`${base}/api/admin/webhooks`);
  expect(listed.status()).toBe(200);
  const { configured, namespaces } = (await listed.json()) as { configured: boolean; namespaces: { id: string; slug: string }[] };
  expect(namespaces[0]!.slug).toBe("global");
  const globalId = namespaces[0]!.id;

  const admin = await adminCtx.newPage();
  await admin.goto("/admin");
  await expect(admin.getByRole("button", { name: /Channel webhooks/ })).toBeVisible();

  if (!configured) {
    await expect(admin.getByTestId("webhooks-not-configured")).toBeVisible();
    const refused = await adminCtx.request.post(`${base}/api/admin/webhooks`, {
      data: { namespaceId: globalId, name: "x", format: "json", url: "https://20.50.2.3/hook", enabled: true },
      headers: { "content-type": "application/json" },
    });
    expect(refused.status()).toBe(409);
    await adminCtx.close();
    await memberCtx.close();
    return;
  }

  const section = admin.getByTestId("webhooks-ns-global");
  const name = `E2E hook ${stamp}`;
  const secretUrl = `https://20.50.2.3/hooks/${stamp}/sig-abcd`;
  // The global namespace may already be at its cap from earlier runs; the add button is then absent.
  const addButton = section.getByRole("button", { name: "Add webhook" });
  test.skip((await addButton.count()) === 0, "global already has the maximum number of webhooks");
  await addButton.click();
  await section.getByLabel("Webhook name").fill(name);
  await section.getByLabel("Format").selectOption("json");
  await section.getByLabel("Webhook URL").fill(secretUrl);
  await section.getByRole("button", { name: "Add webhook" }).click();

  const row = section.getByTestId("webhook-row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row).toContainText("20.50.2.3 …abcd");
  await expect(row).toContainText("No deliveries yet");
  await expect(admin.getByText(secretUrl)).toHaveCount(0);

  // Switch it off with the preference pill.
  const toggle = row.getByRole("switch", { name: `Webhook ${name} enabled` });
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(row.getByRole("switch", { name: `Webhook ${name} enabled` })).toHaveAttribute("aria-checked", "false");

  // Edit: rename with the URL left empty — the hint (and stored URL) stay.
  await row.getByRole("button", { name: "Edit" }).click();
  const form = section.getByTestId("webhook-form");
  await expect(form.getByLabel("Webhook URL")).toHaveValue("");
  await form.getByLabel("Webhook name").fill(`${name} renamed`);
  await form.getByRole("button", { name: "Save" }).click();
  const renamed = section.getByTestId("webhook-row").filter({ hasText: `${name} renamed` });
  await expect(renamed).toContainText("20.50.2.3 …abcd");

  // Delete (confirm dialog).
  admin.once("dialog", (d) => {
    expect(d.message()).toBe(`Delete webhook ${name} renamed? Undelivered posts are discarded.`);
    void d.accept();
  });
  await renamed.getByRole("button", { name: "Delete" }).click();
  await expect(section.getByTestId("webhook-row").filter({ hasText: `${name} renamed` })).toHaveCount(0);

  await adminCtx.close();
  await memberCtx.close();
});

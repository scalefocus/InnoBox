// AI provider e2e (INNOBOX_SPEC.md §22.4, §22.5, §22.9). The API is platform-admin only (a member
// is refused 403). When the server has AI_TOKEN_ENC_KEY, an admin configures a LOCAL provider stub
// (the non-production localhost allowance — never a real provider), loads its models, tests,
// saves, enables and sees Operational; a failing save leaves the pill unchanged; remove returns
// to Not configured. Without the key the card shows the hint and a save is refused 409.
//
// The stub runs inside the Playwright process on 127.0.0.1; the dev server reaches it directly
// (on Jenkins the Playwright container shares the host network).
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { uniqueStamp } from "./helpers/stamp";

const TOKEN = "sk-e2e-stub-key-0042";

function startStub(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { detail: "Invalid API key" });
      if (req.url === "/api/models") return send(200, { data: [{ id: "stub-chat" }, { id: "stub-broken" }] });
      const model = (JSON.parse(body || "{}") as { model?: string }).model;
      if (model === "stub-broken") return send(400, { error: { message: "model stub-broken is unavailable" } });
      send(200, { model, choices: [{ message: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

test("AI provider: platform-admin only; configure stub → load models → test → save → enable → failing save → remove", async ({ browser }) => {
  const stamp = uniqueStamp();
  const base = process.env.E2E_BASE_URL || "http://localhost:3000";

  const memberCtx = await browser.newContext();
  await signIn(memberCtx, { name: `E2E AI Member ${stamp}` });
  expect((await memberCtx.request.get(`${base}/api/admin/ai`)).status()).toBe(403);
  await memberCtx.close();

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E AI Admin ${stamp}`, admin: true });
  const state = await adminCtx.request.get(`${base}/api/admin/ai`);
  expect(state.status()).toBe(200);
  const { keyPresent } = (await state.json()) as { keyPresent: boolean };

  const admin = await adminCtx.newPage();
  const card = admin.getByTestId("ai-provider-card");

  if (!keyPresent) {
    await admin.goto("/admin/settings");
    await expect(card.getByTestId("ai-key-missing")).toBeVisible();
    const refused = await adminCtx.request.put(`${base}/api/admin/ai`, {
      data: { provider: "openai", model: "x", token: "sk-x" },
      headers: { "content-type": "application/json" },
    });
    expect(refused.status()).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("ai_key_missing");
    await adminCtx.close();
    return;
  }

  const stub = await startStub();
  try {
    // The integration is platform-wide: start from Not configured.
    expect((await adminCtx.request.delete(`${base}/api/admin/ai`)).status()).toBe(204);
    await admin.goto("/admin/settings");
    const pill = card.getByTestId("ai-status-pill");
    await expect(pill).toHaveText("Not configured");
    await expect(card.getByRole("switch", { name: "AI enabled" })).toBeDisabled();

    await card.getByLabel("Provider").selectOption("openwebui");
    await card.getByLabel("Base URL").fill(`${stub.base}/api`);
    await card.getByLabel("API key").fill(TOKEN);
    await card.getByRole("button", { name: "Load models" }).click();
    const modelSelect = card.getByRole("combobox", { name: "Model" });
    await expect(modelSelect.locator("option", { hasText: "stub-chat" })).toHaveCount(1);
    await modelSelect.selectOption("stub-chat");

    await card.getByRole("button", { name: "Test", exact: true }).click();
    await expect(card.getByTestId("ai-test-result")).toContainText("Test passed");
    await expect(pill).toHaveText("Not configured", { timeout: 5_000 });

    await card.getByTestId("ai-save").click();
    await expect(pill).toHaveText("Off");
    // The key is write-only: only its last 4 characters come back.
    await expect(card.getByTestId("ai-key-set")).toHaveText("Set · ends …0042");
    const view = await (await adminCtx.request.get(`${base}/api/admin/ai`)).text();
    expect(view).not.toContain(TOKEN);
    expect(JSON.parse(view).config.baseUrl).toBe(stub.base);

    await card.getByRole("switch", { name: "AI enabled" }).click();
    await expect(pill).toHaveText("Operational");
    await expect(card.getByTestId("ai-last-test")).toContainText("Passed");

    // A failing save persists nothing: the pill and the saved model stay.
    await card.getByRole("button", { name: "Refresh" }).click();
    await modelSelect.selectOption("stub-broken");
    await card.getByTestId("ai-save").click();
    await expect(card.getByTestId("ai-test-result")).toContainText("Not saved — the test failed");
    await expect(pill).toHaveText("Operational");
    const after = (await (await adminCtx.request.get(`${base}/api/admin/ai`)).json()) as { config: { model: string } };
    expect(after.config.model).toBe("stub-chat");

    // Remove returns to Not configured.
    admin.once("dialog", (d) => void d.accept());
    await card.getByRole("button", { name: "Remove integration" }).click();
    await expect(pill).toHaveText("Not configured");
  } finally {
    await stub.close();
    await adminCtx.close();
  }
});

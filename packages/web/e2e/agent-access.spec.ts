// Agent access e2e (INNOBOX_SPEC.md §25.13): with agent access on, a person connects an MCP client
// from /agents through the browser consent page; the agent submits a challenge that appears in the
// triage queue with "via agent · <client>"; the person earns Plugged In and Co-Pilot; and revoking
// the connection on /agents stops the agent's next call. The client redirect is read off the
// browser's request (no listener is needed on the loopback port). Agent access and gamification are global
// switches, so the spec turns both back off whatever happens.
import { createHash, randomBytes } from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { signIn } from "./helpers/auth";

const base = () => process.env.E2E_BASE_URL || "http://localhost:3000";
const REDIRECT = "http://127.0.0.1:59999/callback";

async function mcpCall(request: APIRequestContext, token: string, method: string, params: Record<string, unknown> = {}) {
  return request.post(`${base()}/mcp`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method, params },
  });
}

test("connect from /agents through consent; the agent's challenge shows via agent; revoke stops it", async ({ browser, playwright }) => {
  const stamp = Date.now().toString(36);
  const clientName = `E2E Agent ${stamp}`;
  const adminCtx = await browser.newContext();
  const personCtx = await browser.newContext();
  // The agent is a program: its own request context, no browser cookies.
  const agent = await playwright.request.newContext();
  await signIn(adminCtx, { name: `E2E Agents Admin ${stamp}`, admin: true });
  await signIn(personCtx, { name: `E2E Agents Person ${stamp}` });

  const patch = (path: string, data: Record<string, unknown>) => adminCtx.request.patch(`${base()}${path}`, { data, headers: { "content-type": "application/json" } });
  try {
    expect((await patch("/api/admin/mcp", { enabled: true, restrictedContentEnabled: false })).status()).toBe(200);
    expect((await patch("/api/admin/settings", { gamificationEnabled: true })).status()).toBe(200);

    // The /agents page offers the server URL and the account menu links to it.
    const page = await personCtx.newPage();
    await page.goto("/agents");
    await expect(page.getByTestId("agents-server-url")).toContainText("/mcp");
    await expect(page.getByTestId("agents-snippet-claude-code")).toContainText("claude mcp add --transport http innobox");

    // The client discovers the server and registers itself.
    const resource = (await (await agent.get(`${base()}/.well-known/oauth-protected-resource`)).json()).resource as string;
    const registered = await agent.post(`${base()}/oauth/register`, { data: { client_name: clientName, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" } });
    expect(registered.status()).toBe(201);
    const clientId = (await registered.json()).client_id as string;

    // The person approves it in the browser.
    const verifier = randomBytes(40).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URL(`${base()}/oauth/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: stamp, resource })) {
      authorize.searchParams.set(k, v);
    }
    // The approval's 303 goes to the client's loopback redirect. Nothing listens there (the browser
    // shows a connection error) — the redirected request itself carries the code and state.
    let callback: URL | null = null;
    page.on("request", (r) => {
      if (r.url().startsWith(REDIRECT)) callback = new URL(r.url());
    });
    await page.goto(authorize.toString());
    await expect(page.getByRole("heading", { name: `Connect ${clientName} to InnoBox?` })).toBeVisible();
    await expect(page.getByText("It cannot like, change a status, assign, triage or administer.")).toBeVisible();
    await page.getByRole("button", { name: "Approve" }).click();
    await expect.poll(() => callback?.searchParams.get("code") ?? null).not.toBeNull();
    expect(callback!.searchParams.get("state")).toBe(stamp);

    // Code → tokens → the MCP endpoint.
    const tokenRes = await agent.post(`${base()}/oauth/token`, {
      form: { grant_type: "authorization_code", code: callback!.searchParams.get("code")!, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource },
    });
    expect(tokenRes.status()).toBe(200);
    const token = (await tokenRes.json()).access_token as string;
    const ref = (await (await mcpCall(agent, token, "tools/call", { name: "innobox_get_reference_data", arguments: {} })).json()).result.structuredContent;
    const internal = ref.impactAreas.find((a: { name: string }) => a.name === "Internal");
    const global = ref.namespaces.find((n: { slug: string }) => n.slug === "global");
    const submitted = await mcpCall(agent, token, "tools/call", {
      name: "innobox_submit_challenge",
      arguments: { title: `Agent challenge ${stamp}`, description: "Submitted by an AI agent in e2e.", impactAreaId: internal.id, namespaceId: global.id },
    });
    const created = (await submitted.json()).result.structuredContent as { number: string };
    expect(created.number).toMatch(/^CH-\d+$/);

    // The triage queue shows it with the agent's name.
    const adminPage = await adminCtx.newPage();
    await adminPage.goto("/admin/triage");
    const row = adminPage.locator("tr, .row").filter({ hasText: `Agent challenge ${stamp}` }).first();
    await expect(row.getByTestId("via-agent-tag")).toHaveText(`via agent · ${clientName}`);

    // Plugged In and Co-Pilot are earned.
    await page.goto("/profile");
    const earned = page.locator(".achievements .badge-tile:not(.locked)");
    await expect(earned.filter({ hasText: "Plugged In" })).toBeVisible();
    await expect(earned.filter({ hasText: "Co-Pilot" })).toBeVisible();

    // Revoking on /agents stops the next call.
    await page.goto("/agents");
    const connection = page.getByTestId("agents-connection").filter({ hasText: clientName });
    await connection.getByRole("button", { name: "Revoke" }).click();
    await expect(connection).toHaveCount(0);
    expect((await mcpCall(agent, token, "ping")).status()).toBe(401);
  } finally {
    await patch("/api/admin/mcp", { enabled: false });
    await patch("/api/admin/settings", { gamificationEnabled: false });
    await agent.dispose();
    await adminCtx.close();
    await personCtx.close();
  }
});

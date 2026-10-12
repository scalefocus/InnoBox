// e2e support for the §22 AI features (INNOBOX_SPEC.md §22.9): a LOCAL provider stub inside the
// Playwright process (the dev server reaches it on 127.0.0.1 through the non-production localhost
// allowance — on Jenkins the Playwright container shares the host network), plus helpers that
// configure the platform's single AI integration against it through the admin API and remove it
// afterwards. Every spec using it needs the server to have AI_TOKEN_ENC_KEY (it self-skips
// otherwise). The integration is platform-wide, so specs that use it run serially (workers: 1).
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { APIRequestContext } from "@playwright/test";

export const STUB_TOKEN = "sk-e2e-ai-stub-0099";
const JSON_HEADERS = { "content-type": "application/json" };

export interface StubCall {
  system: string;
  user: string;
}

/** The assistant text for one call, or an HTTP failure. */
export type StubReply = string | { status: number };

export interface AiStub {
  baseUrl: string;
  calls: StubCall[];
  close: () => Promise<void>;
}

/** Starts the stub. `reply` decides each chat answer; the connectivity check always passes. */
export function startAiStub(reply: (call: StubCall) => StubReply): Promise<AiStub> {
  const calls: StubCall[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== `Bearer ${STUB_TOKEN}`) return send(401, { detail: "Invalid API key" });
      if (req.url === "/api/models") return send(200, { data: [{ id: "stub-chat" }] });
      const parsed = JSON.parse(body || "{}") as { model?: string; messages?: { role: string; content: string }[] };
      const call: StubCall = {
        system: parsed.messages?.find((m) => m.role === "system")?.content ?? "",
        user: (parsed.messages ?? []).filter((m) => m.role === "user").map((m) => m.content).join("\n"),
      };
      const answer = call.system.includes("connectivity check") ? "OK" : reply(call);
      if (!call.system.includes("connectivity check")) calls.push(call);
      if (typeof answer !== "string") return send(answer.status, { error: { message: "stub failure" } });
      send(200, { model: parsed.model, choices: [{ message: { content: answer }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3 } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        calls,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

/** True when the server can hold an AI configuration (AI_TOKEN_ENC_KEY is set). */
export async function aiKeyPresent(admin: APIRequestContext, base: string): Promise<boolean> {
  const res = await admin.get(`${base}/api/admin/ai`);
  if (res.status() !== 200) return false;
  return ((await res.json()) as { keyPresent: boolean }).keyPresent;
}

/** Configures and enables the integration against the stub, with the given switches. */
export async function enableAiStub(
  admin: APIRequestContext,
  base: string,
  stub: AiStub,
  switches: { restrictedContent?: boolean; features?: Record<string, boolean> } = {},
): Promise<void> {
  const saved = await admin.put(`${base}/api/admin/ai`, {
    data: { provider: "openwebui", baseUrl: stub.baseUrl, token: STUB_TOKEN, model: "stub-chat" },
    headers: JSON_HEADERS,
  });
  if (saved.status() !== 200) throw new Error(`PUT /api/admin/ai → ${saved.status()}: ${await saved.text()}`);
  const enabled = await admin.patch(`${base}/api/admin/ai`, { data: { enabled: true }, headers: JSON_HEADERS });
  if (enabled.status() !== 200) throw new Error(`PATCH /api/admin/ai → ${enabled.status()}: ${await enabled.text()}`);
  const body = { restrictedContent: switches.restrictedContent ?? false, features: switches.features ?? {} };
  const sw = await admin.put(`${base}/api/admin/ai/switches`, { data: body, headers: JSON_HEADERS });
  if (sw.status() !== 200) throw new Error(`PUT /api/admin/ai/switches → ${sw.status()}: ${await sw.text()}`);
}

/** Removes the integration and switches every task back off. */
export async function disableAiStub(admin: APIRequestContext, base: string, featureSwitches: string[] = []): Promise<void> {
  const features = Object.fromEntries(featureSwitches.map((k) => [k, false]));
  await admin.put(`${base}/api/admin/ai/switches`, { data: { restrictedContent: false, features }, headers: JSON_HEADERS }).catch(() => {});
  await admin.delete(`${base}/api/admin/ai`).catch(() => {});
}

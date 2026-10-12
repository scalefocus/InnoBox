// Test support for the §22 AI task suites (INNOBOX_SPEC.md §22.9): a LOCAL provider stub (plain
// HTTP on 127.0.0.1 — the non-production localhost allowance; never a real provider) and a direct
// ai_integration row, enabled, pointing at it. Used only by the gated *.dbtest.ts files.
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import { createAiClient, encryptAiToken, type AiClient } from "@innobox/shared/ai";

export const STUB_TOKEN = "sk-dbtest-stub-0001";

export interface StubCall {
  model: string;
  system: string;
  user: string;
}

/** What the stub answers for one call: the assistant's text, or an HTTP failure. */
export type StubReply = { text: string; delayMs?: number } | { status: number; body?: unknown };

export interface ProviderStub {
  baseUrl: string;
  calls: StubCall[];
  reply: (fn: (call: StubCall) => StubReply) => void;
  close: () => Promise<void>;
}

export async function startProviderStub(): Promise<ProviderStub> {
  const calls: StubCall[] = [];
  let handler: (call: StubCall) => StubReply = () => ({ text: "{}" });
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status: number, payload: unknown) => {
        if (res.writableEnded) return;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== `Bearer ${STUB_TOKEN}`) return send(401, { detail: "Invalid API key" });
      const parsed = JSON.parse(body || "{}") as { model?: string; messages?: { role: string; content: string }[] };
      const call: StubCall = {
        model: parsed.model ?? "",
        system: parsed.messages?.find((m) => m.role === "system")?.content ?? "",
        user: (parsed.messages ?? []).filter((m) => m.role === "user").map((m) => m.content).join("\n"),
      };
      calls.push(call);
      const reply = handler(call);
      if ("status" in reply) return send(reply.status, reply.body ?? { error: { message: "stub failure" } });
      const answer = () => send(200, { model: call.model, choices: [{ message: { content: reply.text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      if (reply.delayMs) setTimeout(answer, reply.delayMs);
      else answer();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    reply: (fn) => {
      handler = fn;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Replaces the single ai_integration row with an enabled, tested Open WebUI config at the stub. */
export async function configureAi(pool: Pool, key: Buffer, baseUrl: string): Promise<void> {
  await pool.query(`delete from ai_integration`);
  await pool.query(
    `insert into ai_integration (id, enabled, provider, base_url, model, token_enc, token_last4, last_test_at, last_test_ok)
     values (true, true, 'openwebui', $1, 'stub-model', $2, '0001', now(), true)`,
    [baseUrl, encryptAiToken(STUB_TOKEN, key)],
  );
}

/** Sets a boolean platform switch (restricted content, a task switch). */
export async function setSwitch(pool: Pool, settingKey: string, on: boolean): Promise<void> {
  await pool.query(
    `insert into platform_settings (key, value, updated_at) values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [settingKey, JSON.stringify(on)],
  );
}

export function testAiClient(pool: Pool, key: Buffer, source: "web" | "worker" = "web"): AiClient {
  return createAiClient({ db: pool, key, source, transport: { allowLocalhost: true }, sleep: async () => {} });
}

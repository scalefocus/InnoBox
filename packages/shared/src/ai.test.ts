// Unit tests for the server-only AI plumbing (INNOBOX_SPEC.md §22.2, §22.5, §22.6): the outbound
// guard (non-443, private address, redirect, the non-production localhost allowance), the pinned
// connection, the 1 MB cap, the timeout, the connectivity test and model list, and the helper —
// unknown feature and restricted content refused before any fetch, the retry policy (one retry,
// insufficient_quota never), one usage row per retried call, JSON mode, cancellation, the
// system-log hand-off, metrics, and the encryption round-trip. Driven against a LOCAL plain-HTTP
// server and an in-memory fake database — this suite never touches the internet.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import {
  AiError,
  aiHttp,
  aiLocalhostAllowed,
  aiMetricSamples,
  createAiClient,
  decryptAiToken,
  encryptAiToken,
  listAiModels,
  parseAiKey,
  resetAiMetrics,
  runAiTest,
  vetAiUrl,
  type AiFailure,
  type AiFeature,
  type AiRequestFn,
} from "./ai.js";
import type { DbClient } from "./email-graph.js";
import type { ResolvedAddress } from "./webhook-send.js";

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

async function withServer(handler: Handler, fn: (base: string, seen: { url: string; headers: http.IncomingHttpHeaders; body: string }[]) => Promise<void>) {
  const seen: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const answer = (text = "OK", model = "stub-model") => ({ model, choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 2 } });
const local = { allowLocalhost: true };
const PUBLIC: ResolvedAddress = { address: "20.50.2.3", family: 4 };

// ── Guard ─────────────────────────────────────────────────────────────────────────────────

test("guard: https on 443 only, private addresses refused, localhost only with the allowance", async () => {
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return "ok";
    } catch (e) {
      assert.ok(e instanceof AiError);
      return e.message;
    }
  };
  assert.match(await code(vetAiUrl("http://api.example.com/v1")), /https on port 443/);
  assert.match(await code(vetAiUrl("https://api.example.com:8443/v1")), /https on port 443/);
  assert.match(await code(vetAiUrl("http://localhost:1234/x")), /https on port 443/, "no allowance → refused");
  assert.equal(await code(vetAiUrl("http://localhost:1234/x", local)), "ok");
  assert.match(await code(vetAiUrl("https://10.0.0.1/v1")), /private or internal/);
  assert.match(await code(vetAiUrl("https://ai.example.com/v1", { resolve: async () => [PUBLIC, { address: "192.168.1.5", family: 4 }] })), /private or internal/, "ANY private address refuses");
  assert.match(await code(vetAiUrl("https://ai.example.com/v1", { resolve: async () => { throw new Error("ENOTFOUND ai.example.com"); } })), /could not be resolved/);
  assert.equal(await code(vetAiUrl("https://ai.example.com/v1", { resolve: async () => [PUBLIC] })), "ok");
  assert.equal(aiLocalhostAllowed("production"), false);
  assert.equal(aiLocalhostAllowed("development"), true);
  assert.equal(aiLocalhostAllowed(undefined), true);
});

test("guard: AI_ALLOWED_PRIVATE_HOSTS admits private addresses for a listed host only, never loopback or link-local", async () => {
  const vet = async (raw: string, deps: Parameters<typeof vetAiUrl>[1]) => {
    try {
      await vetAiUrl(raw, deps);
      return { ok: true as const };
    } catch (e) {
      assert.ok(e instanceof AiError);
      return { ok: false as const, message: e.message, detail: e.detail };
    }
  };
  const allowed = new Set(["ai.corp.example", "10.9.8.7"]);
  const priv = async () => [{ address: "10.20.0.5", family: 4 as const }, { address: "fd00::5", family: 6 as const }];
  assert.deepEqual(await vet("https://ai.corp.example/api", { resolve: priv, allowedPrivateHosts: allowed }), { ok: true });
  assert.deepEqual(await vet("https://10.9.8.7/api", { allowedPrivateHosts: allowed }), { ok: true }, "a listed IP literal");

  const unlisted = await vet("https://ai.other.example/api", { resolve: async () => [PUBLIC, { address: "10.20.0.5", family: 4 }], allowedPrivateHosts: allowed });
  assert.equal(unlisted.ok, false);
  assert.match(!unlisted.ok ? unlisted.message : "", /private or internal network\. An operator can allow this host with AI_ALLOWED_PRIVATE_HOSTS/);
  assert.equal(!unlisted.ok && unlisted.detail, "ai.other.example resolved to 20.50.2.3, 10.20.0.5 (private or internal; not in AI_ALLOWED_PRIVATE_HOSTS)");

  const loop = await vet("https://ai.corp.example/api", { resolve: async () => [{ address: "127.0.0.1", family: 4 }], allowedPrivateHosts: allowed });
  assert.equal(!loop.ok && loop.detail, "ai.corp.example resolved to 127.0.0.1 (loopback or link-local; refused even for an allowed host)");
  const meta = await vet("https://ai.corp.example/api", { resolve: async () => [{ address: "10.0.0.1", family: 4 }, { address: "169.254.169.254", family: 4 }], allowedPrivateHosts: allowed });
  assert.equal(meta.ok, false, "one link-local address refuses the host");

  const dns = await vet("https://ai.corp.example/api", { resolve: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND ai.corp.example"), { code: "ENOTFOUND" }); } });
  assert.equal(!dns.ok && dns.detail, "ai.corp.example did not resolve (ENOTFOUND)");
  const form = await vet("https://ai.corp.example:8443/api", {});
  assert.equal(!form.ok && form.detail, null, "URL-form refusals carry the card error only");
});

test("transport: failures carry the host, address and errno code for the system log", async () => {
  // A port nothing listens on: ECONNREFUSED.
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  await assert.rejects(aiHttp({ url: `http://127.0.0.1:${port}/x`, method: "GET", token: "t", timeoutMs: 5_000 }, local), (e: unknown) => {
    assert.ok(e instanceof AiError);
    assert.equal(e.message, "The connection to the AI provider failed.", "the card keeps the fixed text");
    assert.equal(e.detail, "connecting to 127.0.0.1 failed: ECONNREFUSED");
    return true;
  });
  await withServer((_req, _b, res) => setTimeout(() => json(res, 200, answer()), 1_000), async (base) => {
    await assert.rejects(aiHttp({ url: `${base}/slow`, method: "GET", token: "t", timeoutMs: 100 }, local), (e: unknown) => e instanceof AiError && e.detail === "no response from 127.0.0.1 within 0.1 s");
  });
});

test("transport: pinned to the vetted address on 443 with a dedicated agent; bearer never in the URL", async () => {
  await withServer((_req, _b, res) => json(res, 200, answer()), async (base, seen) => {
    const port = Number(new URL(base).port);
    const pinned: string[] = [];
    const request: AiRequestFn = (options, onResponse) => {
      options.lookup!("ignored.example", {}, (_e, address) => pinned.push(String(address)));
      assert.equal(options.port, 443);
      assert.equal(options.protocol, "https:");
      assert.equal(options.rejectUnauthorized, true);
      assert.ok(options.agent, "a dedicated agent — never the proxy-aware global one");
      return http.request({ host: "127.0.0.1", port, path: options.path, method: options.method, headers: options.headers }, onResponse);
    };
    const res = await aiHttp(
      { url: "https://ai.example.com/v1/models", method: "GET", token: "sk-secret", timeoutMs: 5_000 },
      { resolve: async () => [PUBLIC], request },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(pinned, ["20.50.2.3"]);
    assert.equal(seen[0]!.url, "/v1/models");
    assert.equal(seen[0]!.headers.authorization, "Bearer sk-secret");
    assert.equal(seen[0]!.headers.host, "ai.example.com");
  });
});

test("transport: redirects are not followed, 1 MB cap, timeout, cancellation", async () => {
  await withServer((req, _b, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "https://elsewhere.example.com/steal" });
      res.end();
    } else if (req.url === "/big") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("x".repeat(1024 * 1024 + 10));
    } else if (req.url === "/slow") {
      setTimeout(() => json(res, 200, answer()), 1_000);
    } else json(res, 200, answer());
  }, async (base, seen) => {
    const r = await aiHttp({ url: `${base}/redirect`, method: "GET", token: "t", timeoutMs: 5_000 }, local);
    assert.equal(r.status, 302, "the 3xx is returned to the classifier, never followed");
    assert.equal(seen.length, 1);
    await assert.rejects(aiHttp({ url: `${base}/big`, method: "GET", token: "t", timeoutMs: 5_000 }, local), (e: unknown) => e instanceof AiError && /1 MB/.test(e.message));
    await assert.rejects(aiHttp({ url: `${base}/slow`, method: "GET", token: "t", timeoutMs: 100 }, local), (e: unknown) => e instanceof AiError && e.code === "ai_timeout");
    const ctl = new AbortController();
    const pending = aiHttp({ url: `${base}/slow`, method: "GET", token: "t", timeoutMs: 5_000, signal: ctl.signal }, local);
    setTimeout(() => ctl.abort(), 50);
    await assert.rejects(pending, (e: unknown) => e instanceof AiError && e.code === "ai_cancelled");
  });
});

// ── Test & model list ─────────────────────────────────────────────────────────────────────

test("connectivity test: pass on any parseable 2xx; fail carries status and a sanitized error", async () => {
  await withServer((req, body, res) => {
    const parsed = JSON.parse(body || "{}") as { model?: string; max_tokens?: number };
    if (parsed.model === "bad") return json(res, 401, { detail: "Invalid key sk-LEAKEDTOKEN99" });
    assert.equal(req.url, "/api/chat/completions");
    assert.equal(parsed.max_tokens, 1024);
    json(res, 200, answer("Okay!", "llama3:8b"));
  }, async (base) => {
    const pass = await runAiTest({ provider: "openwebui", baseUrl: base, token: "sk-LEAKEDTOKEN99", model: "llama3" }, { transport: local });
    assert.equal(pass.ok, true, "the wording is not checked");
    assert.equal(pass.model, "llama3:8b");
    assert.equal(pass.inputTokens, 11);
    const fail = await runAiTest({ provider: "openwebui", baseUrl: base, token: "sk-LEAKEDTOKEN99", model: "bad" }, { transport: local });
    assert.equal(fail.ok, false);
    assert.equal(fail.httpStatus, 401);
    assert.ok(fail.error && !fail.error.includes("LEAKEDTOKEN"), "never the token");

    const failures: AiFailure[] = [];
    const again = await runAiTest({ provider: "openwebui", baseUrl: base, token: "sk-LEAKEDTOKEN99", model: "bad" }, { transport: local, onFailure: (f) => failures.push(f) });
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.code, "ai_provider_error");
    assert.equal(failures[0]!.httpStatus, 401);
    assert.match(failures[0]!.diagnostic, / — HTTP 401 from 127\.0\.0\.1$/);
    assert.ok(!failures[0]!.diagnostic.includes("LEAKEDTOKEN"), "never the token");
    assert.ok(!JSON.stringify(again).includes("HTTP 401 from"), "the diagnostic never rides on the result");
    await runAiTest({ provider: "openwebui", baseUrl: base, token: "sk-LEAKEDTOKEN99", model: "llama3" }, { transport: local, onFailure: (f) => failures.push(f) });
    assert.equal(failures.length, 1, "a pass reports nothing");
  });
});

test("model list: OpenAI path and filter; failures reported, never thrown", async () => {
  await withServer((req, _b, res) => {
    if (req.headers.authorization !== "Bearer good") return json(res, 401, { error: { message: "Incorrect API key provided" } });
    assert.equal(req.url, "/v1/models");
    json(res, 200, { data: [{ id: "gpt-4o" }, { id: "text-embedding-3-large" }] });
  }, async (base) => {
    assert.deepEqual(await listAiModels({ provider: "openai", baseUrl: `${base}/v1`, token: "good" }, { transport: local }), { ok: true, models: ["gpt-4o"] });
    const bad = await listAiModels({ provider: "openai", baseUrl: `${base}/v1`, token: "wrong" }, { transport: local });
    assert.equal(bad.ok, false);
    assert.equal(!bad.ok && bad.httpStatus, 401);
    const failures: AiFailure[] = [];
    const again = await listAiModels({ provider: "openai", baseUrl: `${base}/v1`, token: "wrong" }, { transport: local, onFailure: (f) => failures.push(f) });
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.diagnostic, "HTTP 401: Incorrect API key provided — HTTP 401 from 127.0.0.1");
    assert.ok(!JSON.stringify(again).includes("from 127.0.0.1"));
  });
});

// ── The helper, against a fake database ───────────────────────────────────────────────────

interface FakeState {
  row: Record<string, unknown> | null;
  settings: Record<string, unknown>;
  usage: Record<string, unknown>[];
  events: Record<string, unknown>[];
  lastCall: { ok: boolean; error: string | null } | null;
  throttleOpen: boolean;
}

function fakeDb(state: FakeState): DbClient {
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("select enabled, provider")) return { rows: state.row ? [state.row] : [], rowCount: state.row ? 1 : 0 };
    if (sql.startsWith("select value from platform_settings")) {
      const key = params[0] as string;
      return key in state.settings ? { rows: [{ value: state.settings[key] }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("update ai_integration set last_call_at")) {
      state.lastCall = { ok: params[0] as boolean, error: params[1] as string | null };
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("insert into ai_usage")) {
      const [feature, user_id, provider, model, input_tokens, output_tokens, latency_ms, ok, error_code] = params;
      state.usage.push({ feature, user_id, provider, model, input_tokens, output_tokens, latency_ms, ok, error_code });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("update ai_integration set last_failure_logged_at")) {
      const won = state.throttleOpen;
      state.throttleOpen = false;
      return { rows: [], rowCount: won ? 1 : 0 };
    }
    if (sql.startsWith("insert into system_events")) {
      const [status, route, path, error_code, message, source] = params;
      state.events.push({ status, route, path, error_code, message, source });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { query: query as DbClient["query"] };
}

const FEATURES: AiFeature[] = [
  { key: "submit_draft", label: "Improve with AI", egress: "The draft text." },
  { key: "triage_assist", label: "Triage assist", egress: "Challenge text.", needsSwitch: true, maxTokens: 500 },
];

function setup(baseUrl: string, opts: { enabled?: boolean; provider?: "openwebui" | "openai"; keyMismatch?: boolean } = {}) {
  const key = randomBytes(32);
  const state: FakeState = {
    row: {
      enabled: opts.enabled ?? true,
      provider: opts.provider ?? "openwebui",
      base_url: baseUrl,
      model: "llama3",
      token_enc: encryptAiToken("sk-RUNTIMETOKEN1", opts.keyMismatch ? randomBytes(32) : key),
      token_last4: "KEN1",
      last_test_at: null,
      last_test_ok: true,
      last_test_error: null,
      last_test_latency_ms: null,
      last_test_model: null,
      last_call_at: null,
      last_call_ok: null,
      last_call_error: null,
      updated_by: null,
      updated_at: new Date(),
    },
    settings: {},
    usage: [],
    events: [],
    lastCall: null,
    throttleOpen: true,
  };
  const sleeps: number[] = [];
  const client = createAiClient({
    db: fakeDb(state),
    key,
    source: "web",
    transport: local,
    features: FEATURES,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { state, client, sleeps };
}

const msg = [{ role: "user" as const, content: "Hello" }];
const rejectsWith = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof AiError && e.code === code);

test("helper: unknown feature, reserved test key and restricted content are refused before any fetch", async () => {
  await withServer((_r, _b, res) => json(res, 200, answer()), async (base, seen) => {
    const { client, state } = setup(base);
    await rejectsWith(client.complete({ feature: "nope", messages: msg }), "ai_unknown_feature");
    await rejectsWith(client.complete({ feature: "test", messages: msg }), "ai_unknown_feature");
    await rejectsWith(client.complete({ feature: "submit_draft", messages: msg, restrictedContent: true }), "ai_restricted_content");
    await rejectsWith(client.complete({ feature: "triage_assist", messages: msg }), "ai_disabled");
    assert.equal(seen.length, 0, "no network call");
    assert.equal(state.usage.length, 0, "refusals write no usage");

    state.settings.ai_restricted_content_enabled = true;
    state.settings.ai_triage_assist_enabled = true;
    await client.complete({ feature: "triage_assist", messages: msg, restrictedContent: true });
    assert.equal(seen.length, 1);
  });
});

test("helper: not configured, disabled, key missing, undecryptable token", async () => {
  await withServer((_r, _b, res) => json(res, 200, answer()), async (base, seen) => {
    const a = setup(base);
    a.state.row = null;
    await rejectsWith(a.client.complete({ feature: "submit_draft", messages: msg }), "ai_not_configured");
    assert.equal(await a.client.available(), false);

    const b = setup(base, { enabled: false });
    await rejectsWith(b.client.complete({ feature: "submit_draft", messages: msg }), "ai_disabled");
    assert.equal(await b.client.available(), false);

    const c = setup(base);
    const noKey = createAiClient({ db: fakeDb(c.state), key: null, source: "worker", transport: local, features: FEATURES });
    await rejectsWith(noKey.complete({ feature: "submit_draft", messages: msg }), "ai_key_missing");
    assert.equal(await noKey.available(), false);

    const d = setup(base, { keyMismatch: true });
    await rejectsWith(d.client.complete({ feature: "submit_draft", messages: msg }), "ai_token_undecryptable");
    assert.equal(d.state.usage.length, 0, "never reached the provider → no usage row");
    assert.deepEqual(d.state.lastCall?.ok, false, "last_call_* is updated");
    assert.equal(d.state.events.length, 1);
    assert.equal(d.state.events[0]!.status, 500);
    assert.equal(await d.client.available(), false);
    assert.equal(seen.length, 0);

    const e = setup(base);
    assert.equal(await e.client.available(), true);
    assert.equal(await e.client.available("submit_draft"), true);
    assert.equal(await e.client.available("triage_assist"), false, "its switch is off");
    assert.equal(await e.client.available("nope"), false);
  });
});

test("helper: success records one usage row, last_call ok, request shaped for the provider", async () => {
  resetAiMetrics();
  await withServer((_r, _b, res) => json(res, 200, answer("Hi there", "llama3:8b")), async (base, seen) => {
    const { client, state } = setup(base);
    const r = await client.complete({ feature: "submit_draft", userId: "u-1", system: "Be kind.", messages: msg, maxTokens: 99_999 });
    assert.equal(r.text, "Hi there");
    assert.equal(r.model, "llama3:8b");
    assert.equal(r.inputTokens, 11);
    const sent = JSON.parse(seen[0]!.body) as { max_tokens: number; messages: { role: string }[] };
    assert.equal(sent.max_tokens, 8192, "capped at the feature ceiling");
    assert.equal(sent.messages[0]!.role, "system");
    assert.equal(seen[0]!.headers.authorization, "Bearer sk-RUNTIMETOKEN1");
    assert.equal(state.usage.length, 1);
    assert.deepEqual({ ...state.usage[0], latency_ms: 0 }, { feature: "submit_draft", user_id: "u-1", provider: "openwebui", model: "llama3", input_tokens: 11, output_tokens: 2, latency_ms: 0, ok: true, error_code: null });
    assert.deepEqual(state.lastCall, { ok: true, error: null });
    assert.equal(state.events.length, 0);
    const samples = aiMetricSamples();
    assert.deepEqual(samples.map((s) => [s.labels, s.value]), [[{ feature: "submit_draft", outcome: "ok" }, 1]]);
  });
});

test("helper: one retry on 5xx and rate-limit 429 (Retry-After capped), one usage row per call", async () => {
  let calls = 0;
  await withServer((_r, _b, res) => {
    calls++;
    if (calls === 1) return json(res, 503, { error: { message: "busy" } });
    if (calls === 2) return json(res, 200, answer());
    if (calls === 3) return json(res, 429, { error: { message: "slow down", code: "rate_limit_exceeded" } }, { "retry-after": "60" });
    if (calls === 4) return json(res, 200, answer());
    return json(res, 500, { error: { message: "down" } });
  }, async (base) => {
    const { client, state, sleeps } = setup(base);
    await client.complete({ feature: "submit_draft", messages: msg });
    assert.equal(calls, 2);
    await client.complete({ feature: "submit_draft", messages: msg });
    assert.equal(calls, 4);
    assert.deepEqual(sleeps, [1_000, 10_000], "default wait, then Retry-After capped at 10 s");
    assert.equal(state.usage.length, 2, "a retried call is still one row");

    // Two failures in a row: retried once, then the call fails — one row, failure logged once.
    await rejectsWith(client.complete({ feature: "submit_draft", messages: msg }), "ai_provider_error");
    assert.equal(calls, 6);
    assert.equal(state.usage.length, 3);
    assert.equal(state.usage[2]!.error_code, "ai_provider_error");
    assert.equal(state.lastCall?.ok, false);
    assert.equal(state.events.length, 1);
    assert.deepEqual({ ...state.events[0], message: "" }, { status: 502, route: "/ai/submit_draft", path: "/api/chat/completions", error_code: "ai_provider_error", message: "", source: "web" });
    assert.equal(state.events[0]!.message, "AI submit_draft call failed: HTTP 500: down — HTTP 500 from 127.0.0.1", "the diagnostic, with the host");
    assert.equal(state.lastCall?.error, "HTTP 500: down", "last_call_error keeps the card text");

    // The throttle slot is taken: the next failure is not logged again.
    await rejectsWith(client.complete({ feature: "submit_draft", messages: msg, retry: false }), "ai_provider_error");
    assert.equal(calls, 7, "retry: false → exactly one attempt");
    assert.equal(state.events.length, 1);
  });
});

test("helper: no retry on other 4xx or insufficient_quota", async () => {
  let calls = 0;
  await withServer((_r, body, res) => {
    calls++;
    const model = (JSON.parse(body) as { model: string }).model;
    if (model === "quota") return json(res, 429, { error: { message: "quota", code: "insufficient_quota" } });
    json(res, 400, { error: { message: "bad request" } });
  }, async (base) => {
    const { client, state } = setup(base);
    await rejectsWith(client.complete({ feature: "submit_draft", messages: msg }), "ai_provider_error");
    assert.equal(calls, 1);
    state.row!.model = "quota";
    await assert.rejects(client.complete({ feature: "submit_draft", messages: msg }), (e: unknown) => e instanceof AiError && e.message === "The OpenAI account has no remaining quota.");
    assert.equal(calls, 2);
  });
});

test("helper: JSON mode parses fenced JSON; invalid JSON is recorded and not retried", async () => {
  let calls = 0;
  await withServer((_r, _b, res) => {
    calls++;
    json(res, 200, answer(calls === 1 ? '```json\n{"ok":true}\n```' : "not json"));
  }, async (base) => {
    const { client, state } = setup(base);
    const r = await client.complete({ feature: "submit_draft", messages: msg, json: true });
    assert.deepEqual(r.json, { ok: true });
    await rejectsWith(client.complete({ feature: "submit_draft", messages: msg, json: true }), "ai_invalid_json");
    assert.equal(calls, 2);
    assert.equal(state.usage[1]!.error_code, "ai_invalid_json");
    assert.equal(state.events[0]!.status, 502);
  });
});

test("helper: a cancelled signal is recorded in usage but never logged", async () => {
  await withServer((_r, _b, res) => setTimeout(() => json(res, 200, answer()), 400), async (base) => {
    const { client, state } = setup(base);
    state.settings.ai_timeouts = { calls: { submit_draft: 10_000 } };
    const ctl = new AbortController();
    const p = client.complete({ feature: "submit_draft", messages: msg, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 30);
    await rejectsWith(p, "ai_cancelled");
    assert.equal(state.usage.length, 1);
    assert.equal(state.usage[0]!.error_code, "ai_cancelled");
    assert.equal(state.events.length, 0, "a cancellation never reaches the system log");
    assert.equal(state.lastCall, null, "nor flips the status pill");
  });
});

test("encryption: round-trip under the AI key; another key cannot decrypt", () => {
  const key = parseAiKey(randomBytes(32).toString("base64"))!;
  assert.ok(key);
  assert.equal(parseAiKey(undefined), null);
  assert.equal(parseAiKey(randomBytes(16).toString("base64")), null);
  const enc = encryptAiToken("sk-abc123", key);
  assert.ok(enc.startsWith("v1:"));
  assert.ok(!enc.includes("sk-abc123"));
  assert.equal(decryptAiToken(enc, key), "sk-abc123");
  assert.equal(decryptAiToken(enc, randomBytes(32)), null);
  assert.equal(decryptAiToken("garbage", key), null);
});

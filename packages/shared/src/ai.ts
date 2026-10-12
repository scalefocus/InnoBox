// AI integration plumbing (INNOBOX_SPEC.md §22.1–§22.9) — SERVER-ONLY (node:crypto, node:http(s),
// node:dns and the database). Import via "@innobox/shared/ai"; never from a client component.
// Shared by web (the admin card's test/save/model list, and the tasks' calls) and worker (the
// background tasks and the hourly usage prune), so both apply one transport guard, one recorder
// and one system-log throttle.
//
//   - The token is AES-256-GCM-encrypted under AI_TOKEN_ENC_KEY (the e-mail token code, through a
//     thin wrapper like the webhook key) and is sent ONLY to the stored base URL.
//   - Outbound requests obey the channel-webhook rules unchanged (§12.4): https on 443, every
//     resolved address public, the connection pinned to the vetted address, TLS always verified,
//     no redirects, proxy variables ignored, responses capped at 1 MB. Only outside production may
//     the base URL be http://localhost / 127.0.0.1 (the e2e provider stub).
//   - Configuration is read on every call (one single-row read), so enable, rotation and removal
//     take effect at once in both processes.
//   - Every call that reaches the provider writes ONE ai_usage row (counts, never content) and
//     updates last_call_*; runtime failures reach the system log at most once per 15 minutes.
import http from "node:http";
import https from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { LookupFunction } from "node:net";
import { decryptToken, encryptToken, parseEmailTokenKey } from "./email-crypto.js";
import type { DbClient } from "./email-graph.js";
import type { MetricSample } from "./metrics.js";
import { sanitizeSystemMessage } from "./system-log.js";
import { ipLiteralFamily, isPublicAddress } from "./webhook-address.js";
import { defaultWebhookResolver, type ResolvedAddress, type WebhookResolver } from "./webhook-send.js";
import {
  AI_ERROR_MESSAGES,
  AI_FAILURE_LOG_INTERVAL_MINUTES,
  AI_FEATURES,
  AI_RESPONSE_MAX_BYTES,
  AI_SETTING_KEYS,
  AI_SYSTEM_LOG_STATUS,
  AI_TEST_MAX_TOKENS,
  AI_TEST_TIMEOUT_MS,
  AI_USAGE_RETENTION_DAYS,
  AiError,
  aiCompletionUrl,
  aiFeatureMaxTokens,
  aiFeatureSwitchKey,
  aiModelsUrl,
  aiRetryDelayMs,
  aiSystemLogRoute,
  buildAiCompletionBody,
  classifyAiHttpFailure,
  effectiveAiTimeoutMs,
  findAiFeature,
  isAiError,
  isAiProvider,
  parseAiCompletionBody,
  parseAiJson,
  parseAiModelList,
  readAiTimeouts,
  sanitizeAiErrorText,
  type AiErrorCode,
  type AiFeature,
  type AiMessage,
  type AiProvider,
} from "./ai-rules.js";

export * from "./ai-rules.js";
export * from "./ai-tasks.js";

// ── At-rest encryption: the `v1:iv:tag:ct` AES-256-GCM helper, under its OWN key ──────────

export const AI_TOKEN_ENC_KEY_ENV = "AI_TOKEN_ENC_KEY";

/** AI_TOKEN_ENC_KEY (32 bytes, base64). null when unset/invalid — the provider form is then off. */
export function parseAiKey(keyB64: string | undefined): Buffer | null {
  return parseEmailTokenKey(keyB64);
}

export function encryptAiToken(token: string, key: Buffer): string {
  return encryptToken(token, key);
}

/** null when the ciphertext no longer decrypts (key rotated, tampered, malformed). */
export function decryptAiToken(enc: string, key: Buffer): string | null {
  try {
    return decryptToken(enc, key);
  } catch {
    return null;
  }
}

// ── Transport: the §12.4 outbound guard with the AI timeout and response cap ─────────────

export interface AiHttpResponse {
  status: number;
  bodyText: string;
  retryAfter: string | null;
}

/** The request primitive, injectable so tests can drive a local server — never the internet. */
export type AiRequestFn = (options: https.RequestOptions, onResponse: (res: IncomingMessage) => void) => ClientRequest;

export interface AiTransportDeps {
  resolve?: WebhookResolver;
  /** Replaces https.request for the vetted (non-local) path. */
  request?: AiRequestFn;
  /** Admits http://localhost / 127.0.0.1 — only ever true outside production. */
  allowLocalhost?: boolean;
}

export interface AiHttpRequest {
  url: string;
  method: "GET" | "POST";
  token: string;
  body?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** Whether this process may use the localhost allowance: never in a production build. */
export function aiLocalhostAllowed(nodeEnv: string | undefined): boolean {
  return nodeEnv !== "production";
}

type Vetted =
  | { local: true; url: URL }
  | { local: false; url: URL; hostname: string; address: ResolvedAddress };

/** Form rules, then the address check after resolution: refused when ANY resolved address is not
 *  public. Fixed messages only — never the URL. */
export async function vetAiUrl(raw: string, deps: AiTransportDeps = {}): Promise<Vetted> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AiError("ai_provider_error", { message: "The AI provider address is not a valid URL." });
  }
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (url.username !== "" || url.password !== "") throw new AiError("ai_provider_error", { message: "The AI provider address must not contain credentials." });
  if (deps.allowLocalhost && url.protocol === "http:" && LOCAL_HOSTS.has(hostname)) return { local: true, url };
  if (url.protocol !== "https:" || url.port !== "") throw new AiError("ai_provider_error", { message: "The AI provider address must use https on port 443." });
  const literal = ipLiteralFamily(hostname);
  if (literal !== 0) {
    if (!isPublicAddress(hostname)) throw new AiError("ai_provider_error", { message: "The AI provider address is on a private or internal network." });
    return { local: false, url, hostname, address: { address: hostname, family: literal } };
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await (deps.resolve ?? defaultWebhookResolver)(hostname);
  } catch {
    throw new AiError("ai_provider_error", { message: "The AI provider address could not be resolved.", retryable: true });
  }
  if (addresses.length === 0) throw new AiError("ai_provider_error", { message: "The AI provider address could not be resolved.", retryable: true });
  if (addresses.some((a) => !isPublicAddress(a.address))) {
    throw new AiError("ai_provider_error", { message: "The AI provider address is on a private or internal network." });
  }
  return { local: false, url, hostname, address: addresses[0]! };
}

/**
 * One HTTP exchange with the provider. Resolves with the status and body (≤ 1 MB) for ANY
 * status — the caller classifies. Throws AiError for: guard refusals, network failure
 * (retryable), timeout (`ai_timeout`), an oversized body, and cancellation (`ai_cancelled`).
 * Error messages are fixed text — never `err.message`, which might echo the URL.
 */
export async function aiHttp(req: AiHttpRequest, deps: AiTransportDeps = {}): Promise<AiHttpResponse> {
  if (req.signal?.aborted) throw new AiError("ai_cancelled");
  const vet = await vetAiUrl(req.url, deps);
  const headers: Record<string, string> = {
    host: vet.url.host,
    accept: "application/json",
    authorization: `Bearer ${req.token}`,
  };
  if (req.body !== undefined) {
    headers["content-type"] = "application/json; charset=utf-8";
    headers["content-length"] = String(Buffer.byteLength(req.body));
  }
  const path = `${vet.url.pathname}${vet.url.search}`;

  return new Promise<AiHttpResponse>((resolve, reject) => {
    let settled = false;
    let request: ClientRequest | undefined;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const fail = (err: AiError) => {
      done(() => reject(err));
      request?.destroy();
    };
    const onAbort = () => fail(new AiError("ai_cancelled"));
    const timer = setTimeout(() => fail(new AiError("ai_timeout")), req.timeoutMs);
    req.signal?.addEventListener("abort", onAbort, { once: true });

    const onResponse = (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const ra = res.headers["retry-after"];
      const retryAfter = typeof ra === "string" ? ra : null;
      const chunks: Buffer[] = [];
      let read = 0;
      res.on("data", (chunk: Buffer) => {
        read += chunk.length;
        if (read > AI_RESPONSE_MAX_BYTES) {
          fail(new AiError("ai_provider_error", { httpStatus: status, message: "The AI provider's response was larger than 1 MB." }));
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => done(() => resolve({ status, bodyText: Buffer.concat(chunks).toString("utf8"), retryAfter })));
      res.on("error", () => fail(new AiError("ai_provider_error", { message: "The connection to the AI provider failed.", retryable: true })));
    };

    try {
      if (vet.local) {
        request = http.request(
          { protocol: "http:", hostname: vet.url.hostname, port: vet.url.port || 80, path, method: req.method, headers, agent: new http.Agent({ keepAlive: false }) },
          onResponse,
        );
      } else {
        const { address, hostname } = vet;
        const pinned: LookupFunction = (_host, options, callback) => {
          const cb = callback as (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;
          if ((options as { all?: boolean } | undefined)?.all) cb(null, [{ address: address.address, family: address.family }]);
          else cb(null, address.address, address.family);
        };
        const send = deps.request ?? (https.request as unknown as AiRequestFn);
        request = send(
          {
            protocol: "https:",
            hostname,
            port: 443,
            path,
            method: req.method,
            headers,
            lookup: pinned,
            servername: ipLiteralFamily(hostname) !== 0 ? undefined : hostname,
            rejectUnauthorized: true,
            // A dedicated agent: Node wires HTTP(S)_PROXY only into the global agent, so a proxy
            // can never sit between the guard and the provider.
            agent: new https.Agent({ keepAlive: false }),
          },
          onResponse,
        );
      }
    } catch {
      fail(new AiError("ai_provider_error", { message: "The connection to the AI provider failed.", retryable: true }));
      return;
    }
    request.on("error", () => fail(new AiError("ai_provider_error", { message: "The connection to the AI provider failed.", retryable: true })));
    request.end(req.body);
  });
}

// ── Provider calls ───────────────────────────────────────────────────────────────────────

export interface AiConnection {
  provider: AiProvider;
  /** The normalized base URL. */
  baseUrl: string;
  token: string;
}

export interface AiChatResult {
  text: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** One chat-completions attempt. Throws AiError (classified, sanitized). */
export async function aiChatOnce(
  conn: AiConnection & { model: string },
  input: { system?: string; messages: AiMessage[]; maxTokens: number; json?: boolean },
  opts: { timeoutMs: number; signal?: AbortSignal; transport?: AiTransportDeps; now?: () => number },
): Promise<AiChatResult> {
  const now = opts.now ?? Date.now;
  const res = await aiHttp(
    {
      url: aiCompletionUrl(conn.provider, conn.baseUrl),
      method: "POST",
      token: conn.token,
      body: JSON.stringify(buildAiCompletionBody(conn.provider, conn.model, input)),
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    },
    opts.transport,
  );
  if (res.status < 200 || res.status >= 300) throw classifyAiHttpFailure(res.status, res.bodyText, res.retryAfter, now(), conn.token);
  return parseAiCompletionBody(res.bodyText, res.status);
}

export interface AiTestResult {
  ok: boolean;
  latencyMs: number;
  /** The model that answered (echoed by the provider), when it said. */
  model: string | null;
  httpStatus: number | null;
  /** Sanitized, ≤ 300 characters, never the token or headers. */
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** The connectivity check (§22.5): fixed prompt, 1 024-token budget, 20 s, no retry. Pass =
 *  HTTP 2xx with a parseable answer; the wording is not checked. Never throws. */
export async function runAiTest(conn: AiConnection & { model: string }, opts: { transport?: AiTransportDeps; now?: () => number } = {}): Promise<AiTestResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  try {
    const r = await aiChatOnce(
      conn,
      { system: "You are a connectivity check.", messages: [{ role: "user", content: "Reply with the single word OK." }], maxTokens: AI_TEST_MAX_TOKENS },
      { timeoutMs: AI_TEST_TIMEOUT_MS, transport: opts.transport, now },
    );
    return { ok: true, latencyMs: Math.max(0, now() - started), model: r.model, httpStatus: 200, error: null, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
  } catch (err) {
    const e = isAiError(err) ? err : new AiError("ai_provider_error");
    return {
      ok: false,
      latencyMs: Math.max(0, now() - started),
      model: null,
      httpStatus: e.httpStatus,
      error: sanitizeAiErrorText(e.message, conn.token),
      inputTokens: null,
      outputTokens: null,
    };
  }
}

/** The provider's model list (OpenAI filtered to chat-capable families). 20 s, no retry. */
export async function listAiModels(conn: AiConnection, opts: { transport?: AiTransportDeps; now?: () => number } = {}): Promise<{ ok: true; models: string[] } | { ok: false; error: string; httpStatus: number | null }> {
  try {
    const res = await aiHttp({ url: aiModelsUrl(conn.provider, conn.baseUrl), method: "GET", token: conn.token, timeoutMs: AI_TEST_TIMEOUT_MS }, opts.transport);
    if (res.status < 200 || res.status >= 300) {
      const e = classifyAiHttpFailure(res.status, res.bodyText, res.retryAfter, (opts.now ?? Date.now)(), conn.token);
      return { ok: false, error: sanitizeAiErrorText(e.message, conn.token), httpStatus: res.status };
    }
    return { ok: true, models: parseAiModelList(conn.provider, res.bodyText) };
  } catch (err) {
    const e = isAiError(err) ? err : new AiError("ai_provider_error");
    return { ok: false, error: sanitizeAiErrorText(e.message, conn.token), httpStatus: e.httpStatus };
  }
}

// ── The stored configuration ─────────────────────────────────────────────────────────────

export interface AiIntegrationRow {
  enabled: boolean;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  tokenEnc: string;
  tokenLast4: string;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  lastTestLatencyMs: number | null;
  lastTestModel: string | null;
  lastCallAt: Date | null;
  lastCallOk: boolean | null;
  lastCallError: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

interface RawIntegrationRow {
  enabled: boolean;
  provider: string;
  base_url: string;
  model: string;
  token_enc: string;
  token_last4: string;
  last_test_at: Date | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  last_test_latency_ms: number | null;
  last_test_model: string | null;
  last_call_at: Date | null;
  last_call_ok: boolean | null;
  last_call_error: string | null;
  updated_by: string | null;
  updated_at: Date;
}

/** The single row, or null when not configured. */
export async function readAiIntegration(db: DbClient): Promise<AiIntegrationRow | null> {
  const { rows } = await db.query<RawIntegrationRow>(
    `select enabled, provider, base_url, model, token_enc, token_last4, last_test_at, last_test_ok, last_test_error,
            last_test_latency_ms, last_test_model, last_call_at, last_call_ok, last_call_error, updated_by, updated_at
       from ai_integration where id`,
  );
  const r = rows[0];
  if (!r || !isAiProvider(r.provider)) return null;
  return {
    enabled: r.enabled,
    provider: r.provider,
    baseUrl: r.base_url,
    model: r.model,
    tokenEnc: r.token_enc,
    tokenLast4: r.token_last4,
    lastTestAt: r.last_test_at,
    lastTestOk: r.last_test_ok,
    lastTestError: r.last_test_error,
    lastTestLatencyMs: r.last_test_latency_ms,
    lastTestModel: r.last_test_model,
    lastCallAt: r.last_call_at,
    lastCallOk: r.last_call_ok,
    lastCallError: r.last_call_error,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

async function readSetting(db: DbClient, key: string): Promise<unknown> {
  const { rows } = await db.query<{ value: unknown }>(`select value from platform_settings where key = $1`, [key]);
  return rows[0]?.value;
}

export async function readAiSwitch(db: DbClient, key: string): Promise<boolean> {
  return (await readSetting(db, key)) === true;
}

// ── Recording ────────────────────────────────────────────────────────────────────────────

export interface AiUsageRecord {
  feature: string;
  userId: string | null;
  provider: AiProvider;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  ok: boolean;
  errorCode: string | null;
}

/** One ai_usage row — counts only: never the prompt, the response, the base URL or the token. */
export async function recordAiUsage(db: DbClient, r: AiUsageRecord): Promise<void> {
  await db.query(
    `insert into ai_usage (feature, user_id, provider, model, input_tokens, output_tokens, latency_ms, ok, error_code)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [r.feature, r.userId, r.provider, r.model.slice(0, 200), r.inputTokens, r.outputTokens, Math.max(0, Math.round(r.latencyMs)), r.ok, r.errorCode],
  );
}

/** A person's recent calls of one feature, for the per-user limits of §22.10 and §22.13
 *  (counted from ai_usage, so every process — and a restart — sees the same numbers). */
export async function countAiUserCalls(db: DbClient, userId: string, feature: string): Promise<{ lastMinute: number; lastDay: number }> {
  const { rows } = await db.query<{ last_minute: number; last_day: number }>(
    `select (count(*) filter (where created_at > now() - interval '1 minute'))::int as last_minute,
            count(*)::int as last_day
       from ai_usage
      where feature = $1 and user_id = $2 and created_at > now() - interval '24 hours'`,
    [feature, userId],
  );
  return { lastMinute: rows[0]?.last_minute ?? 0, lastDay: rows[0]?.last_day ?? 0 };
}

/** Which per-user limit a new call would break, if any. */
export function aiUserLimitHit(counts: { lastMinute: number; lastDay: number }, limits: { perMinute: number; perDay: number }): "minute" | "day" | null {
  if (counts.lastMinute >= limits.perMinute) return "minute";
  if (counts.lastDay >= limits.perDay) return "day";
  return null;
}

/** The hourly prune (worker housekeeping): ai_usage keeps 365 days. */
export async function pruneAiUsage(db: DbClient, retentionDays: number = AI_USAGE_RETENTION_DAYS): Promise<number> {
  const { rowCount } = await db.query(`delete from ai_usage where created_at < now() - make_interval(days => $1::int)`, [retentionDays]);
  return rowCount ?? 0;
}

/**
 * The system-log throttle (§22.6, §14.7): claims the platform-wide 15-minute slot with a
 * conditional UPDATE — so web and worker never double-log — and, when it wins, writes one
 * system_events row with no user and no item number. Returns whether a row was written.
 */
export async function logAiFailure(
  db: DbClient,
  input: { source: "web" | "worker"; feature: string; code: AiErrorCode; endpointPath: string; message: string },
): Promise<boolean> {
  const status = AI_SYSTEM_LOG_STATUS[input.code];
  if (!status) return false;
  const claimed = await db.query(
    `update ai_integration
        set last_failure_logged_at = now()
      where id
        and (last_failure_logged_at is null
             or last_failure_logged_at < now() - make_interval(mins => $1::int))`,
    [AI_FAILURE_LOG_INTERVAL_MINUTES],
  );
  if ((claimed.rowCount ?? 0) === 0) return false;
  await db.query(
    `insert into system_events (status, method, route, path, error_code, message, source)
     values ($1, 'POST', $2, $3, $4, $5, $6)`,
    [status, aiSystemLogRoute(input.feature).slice(0, 512), input.endpointPath.slice(0, 2048), input.code, sanitizeSystemMessage(input.message), input.source],
  );
  return true;
}

// ── Metrics ──────────────────────────────────────────────────────────────────────────────

const aiCallCounts = new Map<string, number>();

/** `innobox_ai_calls_total{feature,outcome}` — outcome is `ok` or the AiError code. */
export function countAiCall(feature: string, outcome: string): void {
  const k = `${feature}\u0000${outcome}`;
  aiCallCounts.set(k, (aiCallCounts.get(k) ?? 0) + 1);
}

export function aiMetricSamples(): MetricSample[] {
  return [...aiCallCounts.entries()].map(([k, value]) => {
    const [feature, outcome] = k.split("\u0000") as [string, string];
    return { name: "innobox_ai_calls_total", help: "AI provider calls by feature and outcome", type: "counter" as const, value, labels: { feature, outcome } };
  });
}

/** For tests. */
export function resetAiMetrics(): void {
  aiCallCounts.clear();
}

// ── The helper (§22.6) ───────────────────────────────────────────────────────────────────

export interface AiCompleteOptions {
  /** A registry key. `test` is reserved; an unregistered key throws before any network call. */
  feature: string;
  /** The person the call runs for; omitted for background work. */
  userId?: string | null;
  system?: string;
  messages: AiMessage[];
  /** Capped at the feature's registered ceiling. */
  maxTokens?: number;
  json?: boolean;
  /** false → exactly one attempt (interactive callers). */
  retry?: boolean;
  signal?: AbortSignal;
  /** The input includes namespace-restricted content: refused unless the platform switch is on. */
  restrictedContent?: boolean;
}

export interface AiCompleteResult {
  text: string;
  json?: unknown;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

export interface AiClientDeps {
  db: DbClient;
  /** Parsed AI_TOKEN_ENC_KEY, or null. */
  key: Buffer | null;
  source: "web" | "worker";
  transport?: AiTransportDeps;
  /** Injectable for tests. */
  features?: readonly AiFeature[];
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface AiClient {
  complete(opts: AiCompleteOptions): Promise<AiCompleteResult>;
  /** Configured, enabled and the token decrypts (and, for a feature that needs one, its
   *  switch is on). When false every affordance is hidden. */
  available(feature?: string): Promise<boolean>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AiError("ai_cancelled"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AiError("ai_cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function logAiConsole(msg: string, err: unknown): void {
  console.error(JSON.stringify({ level: "error", msg, error: String(err) }));
}

export function createAiClient(deps: AiClientDeps): AiClient {
  const features = deps.features ?? AI_FEATURES;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;

  /** Bookkeeping never fails the caller: a DB hiccup here is logged and swallowed. */
  const safely = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      logAiConsole(what, err);
    }
  };

  const markCall = (ok: boolean, error: string | null) =>
    safely("ai last_call update failed", () =>
      deps.db.query(`update ai_integration set last_call_at = now(), last_call_ok = $1, last_call_error = $2 where id`, [ok, error]),
    );

  async function complete(opts: AiCompleteOptions): Promise<AiCompleteResult> {
    const feature = findAiFeature(opts.feature, features);
    const label = feature ? feature.key : "unknown";
    const refuse = (code: AiErrorCode): never => {
      countAiCall(label, code);
      throw new AiError(code);
    };
    if (!feature) return refuse("ai_unknown_feature");

    // Refusals before any network call write nothing to ai_usage.
    if (opts.signal?.aborted) return refuse("ai_cancelled");
    const row = await readAiIntegration(deps.db);
    if (!row) return refuse("ai_not_configured");
    if (!row.enabled) return refuse("ai_disabled");
    if (feature.needsSwitch && !(await readAiSwitch(deps.db, aiFeatureSwitchKey(feature.key)))) return refuse("ai_disabled");
    if (opts.restrictedContent && !(await readAiSwitch(deps.db, AI_SETTING_KEYS.restrictedContent))) return refuse("ai_restricted_content");
    if (!deps.key) return refuse("ai_key_missing");
    const token = decryptAiToken(row.tokenEnc, deps.key);
    if (token === null) {
      // Updates last_call_* only — the provider was never reached, so no ai_usage row.
      await markCall(false, AI_ERROR_MESSAGES.ai_token_undecryptable);
      await safely("ai system log failed", () =>
        logAiFailure(deps.db, { source: deps.source, feature: feature.key, code: "ai_token_undecryptable", endpointPath: "/", message: AI_ERROR_MESSAGES.ai_token_undecryptable }),
      );
      return refuse("ai_token_undecryptable");
    }

    const timeouts = readAiTimeouts(await readSetting(deps.db, AI_SETTING_KEYS.timeouts), features);
    const timeoutMs = effectiveAiTimeoutMs(feature, timeouts);
    const ceiling = aiFeatureMaxTokens(feature);
    const maxTokens = Math.min(ceiling, Math.max(1, Math.floor(opts.maxTokens ?? ceiling)));
    const conn = { provider: row.provider, baseUrl: row.baseUrl, token, model: row.model };
    const endpointPath = (() => {
      try {
        return new URL(aiCompletionUrl(row.provider, row.baseUrl)).pathname;
      } catch {
        return "/";
      }
    })();
    const maxAttempts = opts.retry === false ? 1 : 2;
    const started = now();

    let outcome: { ok: true; result: AiChatResult; json?: unknown } | { ok: false; error: AiError };
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await aiChatOnce(conn, { system: opts.system, messages: opts.messages, maxTokens, json: opts.json }, { timeoutMs, signal: opts.signal, transport: deps.transport, now });
        outcome = { ok: true, result };
        if (opts.json) {
          try {
            outcome.json = parseAiJson(result.text);
          } catch (err) {
            outcome = { ok: false, error: isAiError(err) ? err : new AiError("ai_invalid_json") };
          }
        }
        break;
      } catch (err) {
        const e = isAiError(err) ? err : new AiError("ai_provider_error", { retryable: true });
        if (e.retryable && attempt < maxAttempts && !opts.signal?.aborted) {
          try {
            await sleep(aiRetryDelayMs(e.retryAfterMs), opts.signal);
            continue;
          } catch (sleepErr) {
            outcome = { ok: false, error: isAiError(sleepErr) ? sleepErr : new AiError("ai_cancelled") };
            break;
          }
        }
        outcome = { ok: false, error: e };
        break;
      }
    }

    const latencyMs = Math.max(0, now() - started);
    // One row per call, however many attempts it took.
    await safely("ai usage record failed", () =>
      recordAiUsage(deps.db, {
        feature: feature.key,
        userId: opts.userId ?? null,
        provider: row.provider,
        model: row.model,
        inputTokens: outcome.ok ? outcome.result.inputTokens : null,
        outputTokens: outcome.ok ? outcome.result.outputTokens : null,
        latencyMs,
        ok: outcome.ok,
        errorCode: outcome.ok ? null : outcome.error.code,
      }),
    );

    if (!outcome.ok) {
      const e = outcome.error;
      countAiCall(feature.key, e.code);
      // A cancellation is the caller's choice: it is recorded in ai_usage but is not a provider
      // failure, so it neither flips the status pill nor reaches the system log.
      if (e.code !== "ai_cancelled") {
        const text = sanitizeAiErrorText(e.message, token);
        await markCall(false, text);
        await safely("ai system log failed", () =>
          logAiFailure(deps.db, { source: deps.source, feature: feature.key, code: e.code, endpointPath, message: `AI ${feature.key} call failed: ${text}` }),
        );
      }
      throw e;
    }

    countAiCall(feature.key, "ok");
    await markCall(true, null);
    const r = outcome.result;
    return {
      text: r.text,
      ...(opts.json ? { json: outcome.json } : {}),
      model: r.model ?? row.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      latencyMs,
    };
  }

  async function available(featureKey?: string): Promise<boolean> {
    if (!deps.key) return false;
    const row = await readAiIntegration(deps.db);
    if (!row || !row.enabled) return false;
    if (decryptAiToken(row.tokenEnc, deps.key) === null) return false;
    if (featureKey !== undefined) {
      const feature = findAiFeature(featureKey, features);
      if (!feature) return false;
      if (feature.needsSwitch && !(await readAiSwitch(deps.db, aiFeatureSwitchKey(feature.key)))) return false;
    }
    return true;
  }

  return { complete, available };
}

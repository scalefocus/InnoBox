// AI integration rules (INNOBOX_SPEC.md §22.1–§22.9) — PURE: no node imports, no I/O. The
// provider wire shapes (request building, response and error parsing, model-list filtering),
// base-URL normalization, the AI_FEATURES registry, the timeout and display-name settings, the
// retry policy, JSON mode and the status pill derivation. The server-only transport, crypto and
// database half lives in ./ai.ts, which re-exports everything here under `@innobox/shared/ai`.
//
// User-facing strings here never carry a spec reference (invariant 9) or the provider token.

// ── Providers ────────────────────────────────────────────────────────────────────────────

export const AI_PROVIDERS = ["openwebui", "openai"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_PROVIDER_LABEL: Record<AiProvider, string> = { openwebui: "Open WebUI", openai: "OpenAI" };

export function isAiProvider(v: unknown): v is AiProvider {
  return typeof v === "string" && (AI_PROVIDERS as readonly string[]).includes(v);
}

/** Stored explicitly when the admin leaves the OpenAI base URL blank (§22.2). */
export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export const AI_BASE_URL_MAX = 500;
export const AI_MODEL_MAX = 200;
export const AI_TOKEN_MAX = 4096;
/** Provider responses are read up to this many bytes; anything larger is an error (§22.2). */
export const AI_RESPONSE_MAX_BYTES = 1024 * 1024;

// ── Limits & defaults (§22.5, §22.6, §22.8) ──────────────────────────────────────────────

/** The connectivity test and the model list: fixed, not tunable. */
export const AI_TEST_TIMEOUT_MS = 20_000;
export const AI_TEST_MAX_TOKENS = 1024;
export const AI_DEFAULT_MAX_TOKENS = 8192;
export const AI_MAX_TOKENS_CAP = 32_768;
export const AI_DEFAULT_TIMEOUT_MS = 60_000;
export const AI_TIMEOUT_MIN_MS = 10_000;
export const AI_TIMEOUT_MAX_MS = 900_000;
/** `Retry-After` is honoured up to this long; a retry with no header waits AI_RETRY_DEFAULT_MS. */
export const AI_RETRY_AFTER_CAP_MS = 10_000;
export const AI_RETRY_DEFAULT_MS = 1_000;
export const AI_USAGE_RETENTION_DAYS = 365;
/** A runtime failure reaches the system log at most once per this window, platform-wide. */
export const AI_FAILURE_LOG_INTERVAL_MINUTES = 15;
export const AI_ERROR_TEXT_MAX = 300;
export const AI_DISPLAY_NAME_MAX = 24;
export const AI_DEFAULT_DISPLAY_NAME = "AI";
/** The usage panel's window. */
export const AI_USAGE_WINDOW_DAYS = 30;

/** platform_settings keys (§22.3). Per-task switches are `ai_<feature>_enabled`. */
export const AI_SETTING_KEYS = {
  displayName: "ai_display_name",
  timeouts: "ai_timeouts",
  restrictedContent: "ai_restricted_content_enabled",
} as const;

// ── Errors (§22.6) ───────────────────────────────────────────────────────────────────────

export const AI_ERROR_CODES = [
  "ai_not_configured",
  "ai_disabled",
  "ai_key_missing",
  "ai_token_undecryptable",
  "ai_unknown_feature",
  "ai_restricted_content",
  "ai_timeout",
  "ai_provider_error",
  "ai_invalid_json",
  "ai_cancelled",
] as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

/** Admin-facing default messages. A calling task decides what a non-admin sees. */
export const AI_ERROR_MESSAGES: Record<AiErrorCode, string> = {
  ai_not_configured: "No AI provider is configured.",
  ai_disabled: "AI is switched off.",
  ai_key_missing: "Set AI_TOKEN_ENC_KEY — a 32-byte base64 key — on web and worker.",
  ai_token_undecryptable: "The stored API key cannot be decrypted. Re-enter it on the AI provider card.",
  ai_unknown_feature: "This AI feature is not registered.",
  ai_restricted_content: "Namespace-restricted content may not be sent to the AI provider.",
  ai_timeout: "The AI provider did not answer in time.",
  ai_provider_error: "The AI provider returned an error.",
  ai_invalid_json: "The AI provider's answer was not valid JSON.",
  ai_cancelled: "The AI request was cancelled.",
};

export const AI_BUDGET_EXHAUSTED_MESSAGE =
  "The model used its whole token budget before answering (it may be a reasoning model) — no text was returned.";
export const AI_QUOTA_MESSAGE = "The OpenAI account has no remaining quota.";

/** A typed failure. `message` is admin-facing and already sanitized (never the token). */
export class AiError extends Error {
  readonly code: AiErrorCode;
  /** The provider's HTTP status, for `ai_provider_error`. */
  readonly httpStatus: number | null;
  /** Internal: whether the retry policy allows one more attempt. */
  readonly retryable: boolean;
  /** Internal: a 429's Retry-After, in ms. */
  readonly retryAfterMs: number | null;

  constructor(code: AiErrorCode, opts: { message?: string; httpStatus?: number | null; retryable?: boolean; retryAfterMs?: number | null } = {}) {
    super(opts.message ?? AI_ERROR_MESSAGES[code]);
    this.name = "AiError";
    this.code = code;
    this.httpStatus = opts.httpStatus ?? null;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

export function isAiError(err: unknown): err is AiError {
  return err instanceof AiError;
}

/** One line, no control characters, ≤ 300 characters, with the token and any bearer value
 *  redacted — what an admin may see of a provider failure (§22.5). */
export function sanitizeAiErrorText(raw: unknown, token?: string | null): string {
  let text = typeof raw === "string" ? raw : raw instanceof Error ? raw.message : raw == null ? "" : String(raw);
  if (token && token.length >= 4) text = text.split(token).join("[redacted]");
  text = text.replace(/bearer\s+\S+/gi, "Bearer [redacted]");
  text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
  const oneLine = text
    .split(/\r?\n/)[0]!
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine.length > AI_ERROR_TEXT_MAX ? `${oneLine.slice(0, AI_ERROR_TEXT_MAX - 1)}…` : oneLine;
}

// ── Base URL (§22.2) ─────────────────────────────────────────────────────────────────────

export type AiBaseUrlReason = "required" | "invalid_url" | "scheme" | "userinfo" | "query" | "too_long" | "blocked_address";

export const AI_BASE_URL_MESSAGES: Record<AiBaseUrlReason, string> = {
  required: "Enter the Open WebUI base URL",
  invalid_url: "Enter a complete base URL, starting with https://",
  scheme: "The base URL must use https on port 443",
  userinfo: "The base URL must not contain a user name or password",
  query: "The base URL must not contain a query string or fragment",
  too_long: `The base URL must be at most ${AI_BASE_URL_MAX} characters`,
  blocked_address: "This address is on a private or internal network",
};

export type AiBaseUrlResult =
  | { ok: true; url: string; hostname: string; local: boolean }
  | { ok: false; reason: AiBaseUrlReason; message: string };

/** Hosts the non-production e2e provider stub may use over plain http (§22.2). */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** Strict IPv4 / bracket-free IPv6 literal test without importing the address module — the
 *  public-address decision is the transport's (./ai.ts), this only catches obvious literals. */
function looksPrivateLiteral(hostname: string, isPublic: (address: string) => boolean): boolean {
  const literal = /^[0-9.]+$/.test(hostname) || hostname.includes(":");
  return literal && !isPublic(hostname);
}

/** Linear-time trailing-slash strip (a `/\/+$/` replace backtracks quadratically on many slashes). */
function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 0x2f) end--;
  return path.slice(0, end);
}

/**
 * Validates and normalizes a provider base URL. Runs on every form action, so the stored value
 * and the stored-token match always use the same form:
 *  - absolute `https://` on 443, ≤ 500 characters, no userinfo, query or fragment;
 *  - trailing `/` stripped;
 *  - Open WebUI: required, a trailing `/api` segment stripped (`https://host/api` → `https://host`);
 *  - OpenAI: blank → the default; a pasted trailing `/chat/completions` stripped.
 * `allowLocalhost` (never in production) admits `http://localhost` / `http://127.0.0.1` on any port.
 * `isPublicAddress` judges IP literals (injected so this module stays dependency-free).
 */
export function normalizeAiBaseUrl(
  provider: AiProvider,
  raw: unknown,
  opts: { allowLocalhost: boolean; isPublicAddress: (address: string) => boolean },
): AiBaseUrlResult {
  const fail = (reason: AiBaseUrlReason): AiBaseUrlResult => ({ ok: false, reason, message: AI_BASE_URL_MESSAGES[reason] });
  let text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") {
    if (provider === "openwebui") return fail("required");
    text = OPENAI_DEFAULT_BASE_URL;
  }
  if (text.length > AI_BASE_URL_MAX) return fail("too_long");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail("invalid_url");
  }
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (hostname === "") return fail("invalid_url");
  const local = opts.allowLocalhost && url.protocol === "http:" && LOCAL_HOSTS.has(hostname);
  if (!local) {
    if (url.protocol !== "https:") return fail(url.protocol === "http:" ? "scheme" : "invalid_url");
    // WHATWG URL normalizes an explicit :443 on https to "" — anything else is another port.
    if (url.port !== "") return fail("scheme");
  }
  if (url.username !== "" || url.password !== "") return fail("userinfo");
  if (text.includes("?") || text.includes("#")) return fail("query");
  if (!local && looksPrivateLiteral(hostname, opts.isPublicAddress)) return fail("blocked_address");

  let path = stripTrailingSlashes(url.pathname);
  if (provider === "openwebui") path = path.replace(/\/api$/i, "");
  else path = path.replace(/\/chat\/completions$/i, "");
  path = stripTrailingSlashes(path);
  const normalized = `${url.protocol}//${url.host}${path}`;
  if (normalized.length > AI_BASE_URL_MAX) return fail("too_long");
  return { ok: true, url: normalized, hostname, local };
}

/** The stored token may be used only against the stored provider and base URL (§22.1 #6). */
export function storedTokenApplies(
  saved: { provider: AiProvider; baseUrl: string } | null,
  candidate: { provider: AiProvider; baseUrl: string },
): boolean {
  return saved !== null && saved.provider === candidate.provider && saved.baseUrl === candidate.baseUrl;
}

// ── Model & token form values ────────────────────────────────────────────────────────────

export function parseAiModel(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return { ok: false, error: "Choose a model" };
  if (text.length > AI_MODEL_MAX) return { ok: false, error: `The model name must be at most ${AI_MODEL_MAX} characters` };
  if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, error: "The model name contains invalid characters" };
  return { ok: true, value: text };
}

/** "" means "keep / use the stored token". */
export function parseAiToken(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: "" };
  if (typeof raw !== "string") return { ok: false, error: "The API key must be text" };
  const text = raw.trim();
  if (text.length > AI_TOKEN_MAX) return { ok: false, error: `The API key must be at most ${AI_TOKEN_MAX} characters` };
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return { ok: false, error: "The API key must not contain spaces or control characters" };
  return { ok: true, value: text };
}

export function tokenLast4(token: string): string {
  return token.slice(-4);
}

// ── Registry (§22.6) ─────────────────────────────────────────────────────────────────────

export interface AiFeature {
  /** Registry key, also the `ai_usage.feature` value and the metrics label. Never `test`. */
  key: string;
  /** Admin-facing label (the egress notice, the usage panel, the timeouts row). */
  label: string;
  /** Exactly which fields the task sends, in plain language (§22.7). */
  egress: string;
  /** Output-token ceiling; default 8 192, at most 32 768. */
  maxTokens?: number;
  /** Default per-attempt timeout; default 60 s, at most 900 s. */
  timeoutMs?: number;
  /** The task sends third-party content, so it also needs its own platform switch,
   *  `ai_<key>_enabled`, off by default (§22.11–§22.13). */
  needsSwitch?: boolean;
}

export const AI_RESERVED_FEATURE = "test";

/**
 * The tasks that may call the provider (§22.10–§22.13). Each states its egress exactly — the
 * card's "What leaves InnoBox" notice shows it verbatim.
 */
export const AI_FEATURES: readonly AiFeature[] = [
  {
    key: "submit_draft",
    label: "Improve with AI (challenge and solution forms)",
    egress:
      "The text the author is writing — a challenge's title and description, or a solution's description and cost vs benefits with its challenge's title and description — and the names of the active impact areas. Never the client name, the anonymity choice, attachments or anything about the author.",
    maxTokens: 8192,
  },
  {
    key: "triage_assist",
    label: "Triage assist",
    egress:
      "Each challenge awaiting triage or under review: its title, description and impact area, the names of the active impact areas, and the titles of up to 20 other challenges in the same namespace that every reader of the note can see. Never who wrote anything.",
    maxTokens: 4096,
    timeoutMs: 120_000,
    needsSwitch: true,
  },
  {
    key: "duplicate_explain",
    label: "Explain similar challenges",
    egress:
      "When someone is about to submit a challenge: their draft's title and description, and the title and the first 500 characters of the description of each similar challenge the duplicate check found for them. Never who wrote anything.",
    maxTokens: 2048,
    timeoutMs: 10_000,
    needsSwitch: true,
  },
];

export function findAiFeature(key: string, features: readonly AiFeature[] = AI_FEATURES): AiFeature | null {
  if (key === AI_RESERVED_FEATURE) return null;
  return features.find((f) => f.key === key) ?? null;
}

export function aiFeatureSwitchKey(featureKey: string): string {
  return `ai_${featureKey}_enabled`;
}

export function aiFeatureMaxTokens(feature: AiFeature): number {
  return Math.min(AI_MAX_TOKENS_CAP, Math.max(1, Math.floor(feature.maxTokens ?? AI_DEFAULT_MAX_TOKENS)));
}

/** A registry is valid when keys are unique, never `test`, lowercase snake_case, and the
 *  limits are inside their caps. Pinned by a unit test so a bad entry cannot ship. */
export function validateAiRegistry(features: readonly AiFeature[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    if (f.key === AI_RESERVED_FEATURE) problems.push(`"${f.key}" is reserved`);
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(f.key)) problems.push(`"${f.key}" is not a lowercase snake_case key`);
    if (seen.has(f.key)) problems.push(`"${f.key}" is registered twice`);
    seen.add(f.key);
    if (!f.label.trim()) problems.push(`"${f.key}" has no label`);
    if (!f.egress.trim()) problems.push(`"${f.key}" states no egress`);
    if (f.maxTokens !== undefined && (f.maxTokens < 1 || f.maxTokens > AI_MAX_TOKENS_CAP)) problems.push(`"${f.key}" maxTokens out of range`);
    if (f.timeoutMs !== undefined && (f.timeoutMs < AI_TIMEOUT_MIN_MS || f.timeoutMs > AI_TIMEOUT_MAX_MS)) problems.push(`"${f.key}" timeoutMs out of range`);
  }
  return problems;
}

// ── Timeouts (§22.8) ─────────────────────────────────────────────────────────────────────

export interface AiTimeouts {
  /** Per-attempt overrides, ms, by feature key. Only overrides are stored. */
  calls: Record<string, number>;
}

function clampTimeout(ms: number): number {
  return Math.min(AI_TIMEOUT_MAX_MS, Math.max(AI_TIMEOUT_MIN_MS, Math.round(ms / 1000) * 1000));
}

/** The stored setting as read: unknown keys ignored, out-of-range values clamped. */
export function readAiTimeouts(raw: unknown, features: readonly AiFeature[] = AI_FEATURES): AiTimeouts {
  const calls: Record<string, number> = {};
  const stored = raw && typeof raw === "object" ? (raw as { calls?: unknown }).calls : null;
  if (stored && typeof stored === "object") {
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      if (!findAiFeature(key, features)) continue;
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      calls[key] = clampTimeout(value);
    }
  }
  return { calls };
}

export function aiFeatureDefaultTimeoutMs(feature: AiFeature): number {
  return feature.timeoutMs === undefined ? AI_DEFAULT_TIMEOUT_MS : clampTimeout(feature.timeoutMs);
}

export function effectiveAiTimeoutMs(feature: AiFeature, timeouts: AiTimeouts): number {
  return timeouts.calls[feature.key] ?? aiFeatureDefaultTimeoutMs(feature);
}

/**
 * The PUT body `{ calls: { <featureKey>: ms | null } }` — null (or absent) clears an override.
 * Whole seconds, 10–900 s; anything else is `invalid_timeout` naming the field. Unknown keys
 * are ignored, as on read.
 */
export function parseAiTimeoutsInput(
  body: unknown,
  features: readonly AiFeature[] = AI_FEATURES,
): { ok: true; value: AiTimeouts } | { ok: false; field: string; error: string } {
  const calls = body && typeof body === "object" ? (body as { calls?: unknown }).calls : undefined;
  if (calls === undefined || calls === null) return { ok: true, value: { calls: {} } };
  if (typeof calls !== "object" || Array.isArray(calls)) return { ok: false, field: "calls", error: "calls must be an object" };
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(calls as Record<string, unknown>)) {
    if (!findAiFeature(key, features)) continue;
    if (value === null) continue;
    const field = `calls.${key}`;
    if (typeof value !== "number" || !Number.isInteger(value) || value % 1000 !== 0) {
      return { ok: false, field, error: `${field} must be a whole number of seconds` };
    }
    if (value < AI_TIMEOUT_MIN_MS || value > AI_TIMEOUT_MAX_MS) {
      return { ok: false, field, error: `${field} must be between ${AI_TIMEOUT_MIN_MS / 1000} and ${AI_TIMEOUT_MAX_MS / 1000} seconds` };
    }
    out[key] = value;
  }
  return { ok: true, value: { calls: out } };
}

export function sameAiTimeouts(a: AiTimeouts, b: AiTimeouts): boolean {
  const ka = Object.keys(a.calls).sort();
  const kb = Object.keys(b.calls).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a.calls[k] === b.calls[k]);
}

// ── Display name (§22.8) ─────────────────────────────────────────────────────────────────

/** 1–24 printable characters after trimming; "" means the default "AI". */
export function parseAiDisplayName(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: "" };
  if (typeof raw !== "string") return { ok: false, error: "The display name must be text" };
  const text = raw.trim();
  if (text === "") return { ok: true, value: "" };
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)) return { ok: false, error: "The display name may contain printable characters only" };
  if ([...text].length > AI_DISPLAY_NAME_MAX) return { ok: false, error: `The display name must be at most ${AI_DISPLAY_NAME_MAX} characters` };
  return { ok: true, value: text };
}

/** The name end-user surfaces show. */
export function aiDisplayName(stored: unknown): string {
  const parsed = parseAiDisplayName(stored);
  return parsed.ok && parsed.value !== "" ? parsed.value : AI_DEFAULT_DISPLAY_NAME;
}

// ── Status pill (§22.4) ──────────────────────────────────────────────────────────────────

export type AiStatusState = "not_configured" | "off" | "failing" | "operational";

export interface AiStatus {
  state: AiStatusState;
  /** For `failing`: the reason. */
  reason: string | null;
  /** For `failing`: when it was observed (ISO), when known. */
  at: string | null;
}

export interface AiStatusInput {
  configured: boolean;
  enabled: boolean;
  tokenDecrypts: boolean;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  lastCallAt: Date | null;
  lastCallOk: boolean | null;
  lastCallError: string | null;
}

/** Computed on read: Not configured · Off · Failing (the token cannot be decrypted, or the
 *  more recent of the last saved-config test and the last runtime call failed) · Operational. */
export function deriveAiStatus(s: AiStatusInput): AiStatus {
  if (!s.configured) return { state: "not_configured", reason: null, at: null };
  if (!s.enabled) return { state: "off", reason: null, at: null };
  if (!s.tokenDecrypts) return { state: "failing", reason: AI_ERROR_MESSAGES.ai_token_undecryptable, at: null };
  const test = s.lastTestAt ? { at: s.lastTestAt, ok: s.lastTestOk === true, error: s.lastTestError } : null;
  const call = s.lastCallAt ? { at: s.lastCallAt, ok: s.lastCallOk === true, error: s.lastCallError } : null;
  const latest = test && call ? (call.at.getTime() > test.at.getTime() ? call : test) : (test ?? call);
  if (latest && !latest.ok) {
    return { state: "failing", reason: latest.error || AI_ERROR_MESSAGES.ai_provider_error, at: latest.at.toISOString() };
  }
  return { state: "operational", reason: null, at: null };
}

/** Why the enable switch is unavailable (its tooltip), or null when it may be switched on. */
export function aiEnableBlocker(s: { keyPresent: boolean; configured: boolean; tokenDecrypts: boolean; lastTestOk: boolean | null }): string | null {
  if (!s.keyPresent) return AI_ERROR_MESSAGES.ai_key_missing;
  if (!s.configured) return "Save a configuration first.";
  if (!s.tokenDecrypts) return AI_ERROR_MESSAGES.ai_token_undecryptable;
  if (s.lastTestOk !== true) return "The saved configuration needs a passing test.";
  return null;
}

// ── Wire calls (§22.2) ───────────────────────────────────────────────────────────────────

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AiCompletionInput {
  system?: string;
  messages: AiMessage[];
  maxTokens: number;
  json?: boolean;
}

export const AI_JSON_INSTRUCTION =
  "Respond with a single JSON value only — no prose, no explanation and no code fence.";

export function aiCompletionUrl(provider: AiProvider, baseUrl: string): string {
  return provider === "openwebui" ? `${baseUrl}/api/chat/completions` : `${baseUrl}/chat/completions`;
}

export function aiModelsUrl(provider: AiProvider, baseUrl: string): string {
  return provider === "openwebui" ? `${baseUrl}/api/models` : `${baseUrl}/models`;
}

/** The provider request body: Open WebUI takes `max_tokens` and `stream: false`; OpenAI takes
 *  `max_completion_tokens` and `store: false`, and never `temperature` (reasoning models
 *  reject it). JSON mode appends the single-value instruction to the system prompt. */
export function buildAiCompletionBody(provider: AiProvider, model: string, input: AiCompletionInput): Record<string, unknown> {
  const system = input.json ? [input.system?.trim(), AI_JSON_INSTRUCTION].filter(Boolean).join("\n\n") : input.system?.trim();
  const messages: { role: string; content: string }[] = [];
  if (system) messages.push({ role: "system", content: system });
  for (const m of input.messages) messages.push({ role: m.role, content: m.content });
  return provider === "openwebui"
    ? { model, messages, max_tokens: input.maxTokens, stream: false }
    : { model, messages, max_completion_tokens: input.maxTokens, store: false };
}

export interface AiCompletionParsed {
  text: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

function tokenCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

/** Parses a 2xx body. Not JSON / no `choices` → `ai_provider_error`; an empty answer whose
 *  `finish_reason` is "length" is the budget-exhausted message. */
export function parseAiCompletionBody(bodyText: string, httpStatus: number): AiCompletionParsed {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new AiError("ai_provider_error", { httpStatus, message: "The AI provider's response could not be read." });
  }
  const choices = (body as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0 || typeof choices[0] !== "object" || choices[0] === null) {
    throw new AiError("ai_provider_error", { httpStatus, message: "The AI provider's response had no answer." });
  }
  const first = choices[0] as { message?: { content?: unknown }; finish_reason?: unknown };
  const content = typeof first.message?.content === "string" ? first.message.content : "";
  if (content.trim() === "") {
    if (first.finish_reason === "length") throw new AiError("ai_provider_error", { httpStatus, message: AI_BUDGET_EXHAUSTED_MESSAGE });
    throw new AiError("ai_provider_error", { httpStatus, message: "The AI provider returned an empty answer." });
  }
  const usage = (body as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
  const model = (body as { model?: unknown }).model;
  return {
    text: content,
    model: typeof model === "string" && model.trim() ? model.slice(0, AI_MODEL_MAX) : null,
    inputTokens: tokenCount(usage?.prompt_tokens),
    outputTokens: tokenCount(usage?.completion_tokens),
  };
}

/** Chat-capable model ids only, for OpenAI (§22.2): embedding, speech, transcription, image,
 *  moderation and realtime families are dropped. */
const OPENAI_NON_CHAT = /(embedding|tts|speech|audio|whisper|transcri|dall-e|image|moderation|realtime)/i;

export function parseAiModelList(provider: AiProvider, bodyText: string): string[] {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new AiError("ai_provider_error", { message: "The model list could not be read." });
  }
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new AiError("ai_provider_error", { message: "The model list could not be read." });
  const ids = data
    .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === "string" && id.trim() !== "" && id.length <= AI_MODEL_MAX)
    .filter((id) => provider !== "openai" || !OPENAI_NON_CHAT.test(id));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export function parseRetryAfterHeaderMs(header: string | null | undefined, nowMs: number): number | null {
  if (!header) return null;
  const text = header.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/** The wait before the single retry: Retry-After capped at 10 s, else a short default. */
export function aiRetryDelayMs(retryAfterMs: number | null): number {
  if (retryAfterMs === null) return AI_RETRY_DEFAULT_MS;
  return Math.min(AI_RETRY_AFTER_CAP_MS, Math.max(0, retryAfterMs));
}

/**
 * A non-2xx answer → `ai_provider_error` carrying the status and the provider's own message
 * (sanitized). Retryable: 5xx and a rate-limit 429. Not retryable: other 4xx, a 3xx (redirects
 * are never followed) and OpenAI's `insufficient_quota` 429 — a billing condition.
 */
export function classifyAiHttpFailure(status: number, bodyText: string, retryAfterHeader: string | null, nowMs: number, token?: string | null): AiError {
  let body: unknown = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    /* not JSON — no provider message */
  }
  const err = (body as { error?: unknown } | null)?.error;
  const errObj = err && typeof err === "object" ? (err as { message?: unknown; code?: unknown; type?: unknown }) : null;
  const code = typeof errObj?.code === "string" ? errObj.code : typeof errObj?.type === "string" ? errObj.type : null;
  if (status === 429 && code === "insufficient_quota") {
    return new AiError("ai_provider_error", { httpStatus: status, message: AI_QUOTA_MESSAGE, retryable: false });
  }
  const providerText =
    typeof errObj?.message === "string"
      ? errObj.message
      : typeof err === "string"
        ? err
        : typeof (body as { detail?: unknown } | null)?.detail === "string"
          ? ((body as { detail: string }).detail)
          : typeof (body as { message?: unknown } | null)?.message === "string"
            ? ((body as { message: string }).message)
            : "";
  const prefix = status >= 300 && status < 400 ? `The AI provider answered with a redirect (HTTP ${status}), which is not followed` : `HTTP ${status}`;
  const detail = sanitizeAiErrorText(providerText, token);
  const message = sanitizeAiErrorText(detail ? `${prefix}: ${detail}` : prefix, token);
  const retryable = status >= 500 || status === 429;
  return new AiError("ai_provider_error", {
    httpStatus: status,
    message,
    retryable,
    retryAfterMs: status === 429 ? parseRetryAfterHeaderMs(retryAfterHeader, nowMs) : null,
  });
}

/**
 * JSON mode: strip a surrounding code fence (with an optional language tag), parse; failure is
 * `ai_invalid_json`. Plain string slicing, never a backtracking regex: the text is the provider's
 * answer (up to 1 MB) and may be adversarial — e.g. a fence followed by a long whitespace run.
 */
export function parseAiJson(text: string): unknown {
  let s = text.trim();
  if (s.length >= 6 && s.startsWith("```") && s.endsWith("```")) {
    const inner = s.slice(3, -3);
    // A language tag is a run of [A-Za-z0-9_-] right after the opening fence, ended by
    // whitespace. Anchored, over a class disjoint from its terminator — linear.
    const tag = /^[A-Za-z0-9_-]*(?=\s)/.exec(inner);
    s = (tag ? inner.slice(tag[0].length) : inner).trim();
  }
  try {
    return JSON.parse(s);
  } catch {
    throw new AiError("ai_invalid_json");
  }
}

// ── System log (§22.6) ───────────────────────────────────────────────────────────────────

/** Runtime failures that reach the system log (throttled), with their recorded status. */
export const AI_SYSTEM_LOG_STATUS: Partial<Record<AiErrorCode, number>> = {
  ai_timeout: 504,
  ai_provider_error: 502,
  ai_invalid_json: 502,
  ai_token_undecryptable: 500,
};

export function aiSystemLogRoute(featureKey: string): string {
  return `/ai/${featureKey}`;
}

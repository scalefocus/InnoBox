// Unit tests for the pure AI rules (INNOBOX_SPEC.md §22.2–§22.9): base-URL normalization per
// provider, request building and response/error parsing per provider, model-list filtering,
// JSON mode, the retry policy inputs, budget-exhausted vs generic errors, status derivation, the
// stored-token rule, the registry contract, timeouts and the display name.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_BUDGET_EXHAUSTED_MESSAGE,
  AI_FEATURES,
  AI_QUOTA_MESSAGE,
  AiError,
  aiCompletionUrl,
  aiDisplayName,
  aiEnableBlocker,
  aiModelsUrl,
  aiRetryDelayMs,
  buildAiCompletionBody,
  classifyAiHttpFailure,
  deriveAiStatus,
  effectiveAiTimeoutMs,
  findAiFeature,
  normalizeAiBaseUrl,
  parseAiCompletionBody,
  parseAiDisplayName,
  parseAiJson,
  parseAiModel,
  parseAiModelList,
  parseAiTimeoutsInput,
  parseAiToken,
  readAiTimeouts,
  sameAiTimeouts,
  sanitizeAiErrorText,
  storedTokenApplies,
  validateAiRegistry,
  type AiFeature,
  type AiStatusInput,
} from "./ai-rules.js";
import { isPublicAddress } from "./webhook-address.js";

const prod = { allowLocalhost: false, isPublicAddress };
const dev = { allowLocalhost: true, isPublicAddress };
const url = (r: ReturnType<typeof normalizeAiBaseUrl>) => (r.ok ? r.url : `!${r.reason}`);

test("base URL: Open WebUI is required and loses a trailing /api", () => {
  assert.equal(url(normalizeAiBaseUrl("openwebui", "", prod)), "!required");
  assert.equal(url(normalizeAiBaseUrl("openwebui", "https://ai.example.com/api", prod)), "https://ai.example.com");
  assert.equal(url(normalizeAiBaseUrl("openwebui", "https://ai.example.com/api/", prod)), "https://ai.example.com");
  assert.equal(url(normalizeAiBaseUrl("openwebui", "https://ai.example.com/owui/api", prod)), "https://ai.example.com/owui", "a path prefix is kept");
  assert.equal(url(normalizeAiBaseUrl("openwebui", "  https://AI.Example.com/  ", prod)), "https://ai.example.com", "trimmed, host lowercased, slash stripped");
});

test("base URL: OpenAI defaults when blank and loses a pasted /chat/completions", () => {
  assert.equal(url(normalizeAiBaseUrl("openai", "", prod)), "https://api.openai.com/v1");
  assert.equal(url(normalizeAiBaseUrl("openai", undefined, prod)), "https://api.openai.com/v1");
  assert.equal(url(normalizeAiBaseUrl("openai", "https://api.openai.com/v1/chat/completions", prod)), "https://api.openai.com/v1");
  assert.equal(url(normalizeAiBaseUrl("openai", "https://gateway.example.com/openai/v1/", prod)), "https://gateway.example.com/openai/v1");
  assert.equal(url(normalizeAiBaseUrl("openai", "https://gateway.example.com/api", prod)), "https://gateway.example.com/api", "/api is only stripped for Open WebUI");
});

test("base URL: the outbound form rules", () => {
  assert.equal(url(normalizeAiBaseUrl("openai", "http://api.example.com", prod)), "!scheme");
  assert.equal(url(normalizeAiBaseUrl("openai", "https://api.example.com:8443", prod)), "!scheme", "port 443 only");
  assert.equal(url(normalizeAiBaseUrl("openai", "https://api.example.com:443/v1", prod)), "https://api.example.com/v1", "explicit 443 is fine");
  assert.equal(url(normalizeAiBaseUrl("openai", "https://u:p@api.example.com", prod)), "!userinfo");
  assert.equal(url(normalizeAiBaseUrl("openai", "https://api.example.com/v1?x=1", prod)), "!query");
  assert.equal(url(normalizeAiBaseUrl("openai", "https://api.example.com/v1#frag", prod)), "!query");
  assert.equal(url(normalizeAiBaseUrl("openai", "ftp://api.example.com", prod)), "!invalid_url");
  assert.equal(url(normalizeAiBaseUrl("openai", "not a url", prod)), "!invalid_url");
  assert.equal(url(normalizeAiBaseUrl("openai", `https://a.example.com/${"x".repeat(500)}`, prod)), "!too_long");
  assert.equal(url(normalizeAiBaseUrl("openai", "https://10.1.2.3/v1", prod)), "!blocked_address");
  assert.equal(url(normalizeAiBaseUrl("openai", "https://[::1]/v1", prod)), "!blocked_address");
  assert.equal(url(normalizeAiBaseUrl("openai", "https://20.50.2.3/v1", prod)), "https://20.50.2.3/v1");
});

test("base URL: localhost over http only with the non-production allowance", () => {
  assert.equal(url(normalizeAiBaseUrl("openwebui", "http://localhost:8080/api", prod)), "!scheme");
  assert.equal(url(normalizeAiBaseUrl("openwebui", "https://127.0.0.1/api", prod)), "!blocked_address");
  const local = normalizeAiBaseUrl("openwebui", "http://localhost:8080/api", dev);
  assert.ok(local.ok && local.local);
  assert.equal(url(local), "http://localhost:8080");
  assert.equal(url(normalizeAiBaseUrl("openai", "http://127.0.0.1:9999/v1", dev)), "http://127.0.0.1:9999/v1");
  assert.equal(url(normalizeAiBaseUrl("openai", "http://10.0.0.1:9999/v1", dev)), "!scheme", "only the loopback names");
});

test("stored-token rule: same provider and normalized base URL only", () => {
  const saved = { provider: "openai" as const, baseUrl: "https://api.openai.com/v1" };
  assert.equal(storedTokenApplies(saved, { provider: "openai", baseUrl: "https://api.openai.com/v1" }), true);
  assert.equal(storedTokenApplies(saved, { provider: "openwebui", baseUrl: "https://api.openai.com/v1" }), false);
  assert.equal(storedTokenApplies(saved, { provider: "openai", baseUrl: "https://evil.example.com/v1" }), false);
  assert.equal(storedTokenApplies(null, saved), false);
});

test("model and token form values", () => {
  assert.deepEqual(parseAiModel("  gpt-4o-mini "), { ok: true, value: "gpt-4o-mini" });
  assert.equal(parseAiModel("").ok, false);
  assert.equal(parseAiModel("x".repeat(201)).ok, false);
  assert.deepEqual(parseAiToken(undefined), { ok: true, value: "" });
  assert.deepEqual(parseAiToken("  sk-abc  "), { ok: true, value: "sk-abc" });
  assert.equal(parseAiToken("sk abc").ok, false);
  assert.equal(parseAiToken(42).ok, false);
});

test("request building: Open WebUI vs OpenAI", () => {
  assert.equal(aiCompletionUrl("openwebui", "https://h/owui"), "https://h/owui/api/chat/completions");
  assert.equal(aiCompletionUrl("openai", "https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions");
  assert.equal(aiModelsUrl("openwebui", "https://h"), "https://h/api/models");
  assert.equal(aiModelsUrl("openai", "https://api.openai.com/v1"), "https://api.openai.com/v1/models");

  const input = { system: "Be brief.", messages: [{ role: "user" as const, content: "Hi" }], maxTokens: 100 };
  const owui = buildAiCompletionBody("openwebui", "llama3", input);
  assert.deepEqual(owui, { model: "llama3", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }], max_tokens: 100, stream: false });
  const oai = buildAiCompletionBody("openai", "gpt-4o-mini", input);
  assert.equal(oai.max_completion_tokens, 100);
  assert.equal(oai.store, false);
  assert.ok(!("max_tokens" in oai) && !("temperature" in oai) && !("stream" in oai));

  const json = buildAiCompletionBody("openai", "m", { ...input, json: true }) as { messages: { role: string; content: string }[] };
  assert.match(json.messages[0]!.content, /^Be brief\.\n\nRespond with a single JSON value only/);
  const jsonNoSystem = buildAiCompletionBody("openai", "m", { messages: input.messages, maxTokens: 5, json: true }) as { messages: { role: string }[] };
  assert.equal(jsonNoSystem.messages[0]!.role, "system", "JSON mode adds a system message when there is none");
});

test("response parsing: text, usage, model; budget exhausted vs generic errors", () => {
  const ok = parseAiCompletionBody(JSON.stringify({ model: "gpt-x", choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }), 200);
  assert.deepEqual(ok, { text: "OK", model: "gpt-x", inputTokens: 12, outputTokens: 3 });
  const noUsage = parseAiCompletionBody(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), 200);
  assert.equal(noUsage.inputTokens, null);
  assert.equal(noUsage.model, null);

  const err = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      assert.ok(e instanceof AiError);
      return e;
    }
    throw new Error("expected an AiError");
  };
  const budget = err(() => parseAiCompletionBody(JSON.stringify({ choices: [{ message: { content: "  " }, finish_reason: "length" }] }), 200));
  assert.equal(budget.code, "ai_provider_error");
  assert.equal(budget.message, AI_BUDGET_EXHAUSTED_MESSAGE);
  const empty = err(() => parseAiCompletionBody(JSON.stringify({ choices: [{ message: {}, finish_reason: "stop" }] }), 200));
  assert.notEqual(empty.message, AI_BUDGET_EXHAUSTED_MESSAGE);
  assert.equal(err(() => parseAiCompletionBody("<html>", 200)).code, "ai_provider_error");
  assert.equal(err(() => parseAiCompletionBody("{}", 200)).code, "ai_provider_error");
});

test("model lists: OpenAI filtered to chat-capable families, Open WebUI unfiltered", () => {
  const body = JSON.stringify({
    data: ["gpt-4o", "text-embedding-3-small", "tts-1", "whisper-1", "dall-e-3", "gpt-image-1", "omni-moderation-latest", "gpt-4o-realtime-preview", "gpt-4o-mini-transcribe", "o3-mini", "gpt-4o", "gpt-4o-audio-preview"].map((id) => ({ id })),
  });
  assert.deepEqual(parseAiModelList("openai", body), ["gpt-4o", "o3-mini"]);
  assert.deepEqual(parseAiModelList("openwebui", JSON.stringify({ data: [{ id: "llama3:8b" }, { id: "text-embedding-x" }, { name: "no id" }] })), ["llama3:8b", "text-embedding-x"]);
  assert.throws(() => parseAiModelList("openai", "nope"), AiError);
  assert.throws(() => parseAiModelList("openai", "{}"), AiError);
});

test("error bodies: provider message, quota, retryability, redirects, token never echoed", () => {
  const now = Date.parse("2026-10-12T10:00:00Z");
  const e400 = classifyAiHttpFailure(400, JSON.stringify({ error: { message: "model 'x' not found", code: "model_not_found" } }), null, now);
  assert.equal(e400.code, "ai_provider_error");
  assert.equal(e400.httpStatus, 400);
  assert.equal(e400.retryable, false);
  assert.equal(e400.message, "HTTP 400: model 'x' not found");

  const owui = classifyAiHttpFailure(401, JSON.stringify({ detail: "Invalid API key sk-SECRETSECRET1234" }), null, now, "sk-SECRETSECRET1234");
  assert.ok(!owui.message.includes("SECRETSECRET"), "the token is redacted");
  assert.match(owui.message, /^HTTP 401: Invalid API key/);

  const quota = classifyAiHttpFailure(429, JSON.stringify({ error: { message: "You exceeded your current quota", code: "insufficient_quota" } }), "5", now);
  assert.equal(quota.retryable, false, "a billing condition is never retried");
  assert.equal(quota.message, AI_QUOTA_MESSAGE);

  const rate = classifyAiHttpFailure(429, JSON.stringify({ error: { message: "Rate limit", code: "rate_limit_exceeded" } }), "30", now);
  assert.equal(rate.retryable, true);
  assert.equal(rate.retryAfterMs, 30_000);
  assert.equal(aiRetryDelayMs(rate.retryAfterMs), 10_000, "Retry-After honoured up to 10 s");
  assert.equal(aiRetryDelayMs(2_000), 2_000);
  assert.equal(aiRetryDelayMs(null), 1_000);

  assert.equal(classifyAiHttpFailure(503, "upstream down", null, now).retryable, true);
  assert.equal(classifyAiHttpFailure(503, "upstream down", null, now).message, "HTTP 503");
  const redirect = classifyAiHttpFailure(302, "", null, now);
  assert.equal(redirect.retryable, false);
  assert.match(redirect.message, /redirect/);
});

test("sanitizing: one line, capped, bearer values redacted", () => {
  const long = sanitizeAiErrorText(`first line ${"x".repeat(400)}\nsecond`);
  assert.equal(long.length, 300);
  assert.ok(!long.includes("second"));
  assert.equal(sanitizeAiErrorText("Authorization: Bearer abc.def"), "Authorization: Bearer [redacted]");
  assert.equal(sanitizeAiErrorText("key sk-proj-abcdefghijkl leaked"), "key [redacted] leaked");
});

test("JSON mode: fences stripped, invalid JSON is ai_invalid_json", () => {
  assert.deepEqual(parseAiJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseAiJson('```json\n{"a":[1,2]}\n```'), { a: [1, 2] });
  assert.deepEqual(parseAiJson("```\n[1]\n```"), [1]);
  assert.throws(() => parseAiJson("Sure! {\"a\":1}"), (e: unknown) => e instanceof AiError && e.code === "ai_invalid_json");
});

const base: AiStatusInput = {
  configured: true,
  enabled: true,
  tokenDecrypts: true,
  lastTestAt: new Date("2026-10-01T10:00:00Z"),
  lastTestOk: true,
  lastTestError: null,
  lastCallAt: null,
  lastCallOk: null,
  lastCallError: null,
};

test("status: not configured, off, failing (key, latest of test and call), operational", () => {
  assert.equal(deriveAiStatus({ ...base, configured: false }).state, "not_configured");
  assert.equal(deriveAiStatus({ ...base, enabled: false, lastTestOk: false }).state, "off");
  assert.equal(deriveAiStatus({ ...base, tokenDecrypts: false }).state, "failing");
  assert.equal(deriveAiStatus(base).state, "operational");

  const callFailedLater = deriveAiStatus({ ...base, lastCallAt: new Date("2026-10-02T10:00:00Z"), lastCallOk: false, lastCallError: "HTTP 500" });
  assert.deepEqual(callFailedLater, { state: "failing", reason: "HTTP 500", at: "2026-10-02T10:00:00.000Z" });
  const recoveredByTest = deriveAiStatus({ ...base, lastTestAt: new Date("2026-10-03T10:00:00Z"), lastCallAt: new Date("2026-10-02T10:00:00Z"), lastCallOk: false });
  assert.equal(recoveredByTest.state, "operational", "the MORE RECENT of test and call decides");
  const testFailedLater = deriveAiStatus({ ...base, lastTestAt: new Date("2026-10-03T10:00:00Z"), lastTestOk: false, lastTestError: "HTTP 401", lastCallAt: new Date("2026-10-02T10:00:00Z"), lastCallOk: true });
  assert.equal(testFailedLater.state, "failing");
});

test("enable gating reasons", () => {
  const ok = { keyPresent: true, configured: true, tokenDecrypts: true, lastTestOk: true };
  assert.equal(aiEnableBlocker(ok), null);
  assert.match(aiEnableBlocker({ ...ok, keyPresent: false })!, /AI_TOKEN_ENC_KEY/);
  assert.ok(aiEnableBlocker({ ...ok, configured: false }));
  assert.ok(aiEnableBlocker({ ...ok, tokenDecrypts: false }));
  assert.ok(aiEnableBlocker({ ...ok, lastTestOk: false }));
});

const REG: AiFeature[] = [
  { key: "submit_draft", label: "Improve with AI", egress: "The draft's title and description." },
  { key: "triage_assist", label: "Triage assist", egress: "Title, description, impact area.", timeoutMs: 120_000, needsSwitch: true },
];

test("registry: the shipped registry is valid; unknown and reserved keys are not found", () => {
  assert.deepEqual(validateAiRegistry(AI_FEATURES), []);
  assert.deepEqual(validateAiRegistry(REG), []);
  assert.equal(findAiFeature("submit_draft", REG)?.label, "Improve with AI");
  assert.equal(findAiFeature("nope", REG), null);
  assert.equal(findAiFeature("test", [...REG, { key: "test", label: "x", egress: "x" }]), null, "test is reserved");
  assert.ok(validateAiRegistry([{ key: "test", label: "x", egress: "x" }]).length > 0);
  assert.ok(validateAiRegistry([REG[0]!, REG[0]!]).length > 0, "duplicate keys");
  assert.ok(validateAiRegistry([{ key: "big", label: "x", egress: "x", maxTokens: 40_000 }]).length > 0);
  assert.ok(validateAiRegistry([{ key: "slow", label: "x", egress: "x", timeoutMs: 1_000_000 }]).length > 0);
});

test("timeouts: overrides only, unknown keys ignored, clamped on read, validated on write", () => {
  const read = readAiTimeouts({ calls: { submit_draft: 5_000, triage_assist: 2_000_000, ghost: 30_000 } }, REG);
  assert.deepEqual(read, { calls: { submit_draft: 10_000, triage_assist: 900_000 } });
  assert.deepEqual(readAiTimeouts(null, REG), { calls: {} });
  assert.equal(effectiveAiTimeoutMs(REG[0]!, { calls: {} }), 60_000, "default 60 s");
  assert.equal(effectiveAiTimeoutMs(REG[1]!, { calls: {} }), 120_000, "the registered default");
  assert.equal(effectiveAiTimeoutMs(REG[1]!, { calls: { triage_assist: 30_000 } }), 30_000);

  assert.deepEqual(parseAiTimeoutsInput({ calls: { submit_draft: 30_000, ghost: 12, triage_assist: null } }, REG), { ok: true, value: { calls: { submit_draft: 30_000 } } });
  const fraction = parseAiTimeoutsInput({ calls: { submit_draft: 30_500 } }, REG);
  assert.equal(!fraction.ok && fraction.field, "calls.submit_draft");
  const low = parseAiTimeoutsInput({ calls: { submit_draft: 9_000 } }, REG);
  assert.equal(!low.ok && low.field, "calls.submit_draft");
  assert.equal(parseAiTimeoutsInput({ calls: { submit_draft: 901_000 } }, REG).ok, false);
  assert.equal(parseAiTimeoutsInput({ calls: [] }, REG).ok, false);
  assert.ok(sameAiTimeouts({ calls: { a: 1, b: 2 } }, { calls: { b: 2, a: 1 } }));
  assert.ok(!sameAiTimeouts({ calls: { a: 1 } }, { calls: { a: 2 } }));
});

test("display name: 1–24 printable characters; empty means AI", () => {
  assert.deepEqual(parseAiDisplayName("  Ada  "), { ok: true, value: "Ada" });
  assert.deepEqual(parseAiDisplayName(""), { ok: true, value: "" });
  assert.equal(parseAiDisplayName("x".repeat(25)).ok, false);
  assert.equal(parseAiDisplayName("tab\there").ok, false);
  assert.equal(parseAiDisplayName("zero​width").ok, false);
  assert.equal(parseAiDisplayName("🤖".repeat(24)).ok, true, "counted in characters, not UTF-16 units");
  assert.equal(aiDisplayName(""), "AI");
  assert.equal(aiDisplayName(undefined), "AI");
  assert.equal(aiDisplayName("Ada"), "Ada");
  assert.equal(aiDisplayName("bad\u0000"), "AI");
});

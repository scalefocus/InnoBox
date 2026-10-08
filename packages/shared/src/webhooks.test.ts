// Unit tests for the §12.4 channel-webhook rules: URL form + hint, request validation, the
// org-visible leak guard, both payload formats (exact field sets; title as a plain TextRun),
// the retry schedule, status classification, and the system-log mapping (never the URL).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WEBHOOK_BODY_MAX_BYTES,
  WEBHOOK_MAX_ATTEMPTS,
  buildJsonPayload,
  buildTeamsPayload,
  buildTestWebhookMessage,
  classifyWebhookHttpStatus,
  isOrgVisibleWebhookItem,
  parseRetryAfterMs,
  parseWebhookCreate,
  parseWebhookPatch,
  renderWebhookBody,
  validateWebhookUrlForm,
  webhookFailureSystemEvent,
  webhookHeaders,
  webhookItemUrl,
  webhookLastDeliveryLabel,
  webhookReasonText,
  webhookRetryDelayMs,
  webhookTestResultLabel,
  webhookUrlHint,
  type WebhookMessage,
} from "./webhooks.js";

const TEAMS_URL = "https://prod-12.westeurope.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sig=SeCrEtx9Zq";

test("URL form: https on 443 only, no userinfo, ≤ 2048, absolute", () => {
  assert.equal(validateWebhookUrlForm(TEAMS_URL).ok, true, "explicit :443 is fine");
  assert.equal(validateWebhookUrlForm("https://hooks.example.com/x").ok, true);
  const bad: [unknown, string][] = [
    ["http://hooks.example.com/x", "scheme"],
    ["https://hooks.example.com:8443/x", "scheme"],
    ["https://hooks.example.com:80/x", "scheme"],
    ["ftp://hooks.example.com/x", "scheme"],
    ["https://user:pw@hooks.example.com/x", "userinfo"],
    ["https://user@hooks.example.com/x", "userinfo"],
    ["/relative/path", "invalid_url"],
    ["not a url", "invalid_url"],
    ["", "invalid_url"],
    [42, "invalid_url"],
    [`https://hooks.example.com/${"a".repeat(2048)}`, "too_long"],
    ["https://127.0.0.1/x", "blocked_address"],
    ["https://[::1]/x", "blocked_address"],
    ["https://[::ffff:10.0.0.1]/x", "blocked_address"],
    ["https://169.254.169.254/latest/meta-data", "blocked_address"],
  ];
  for (const [input, reason] of bad) {
    const r = validateWebhookUrlForm(input);
    assert.equal(r.ok, false, String(input).slice(0, 60));
    if (!r.ok) {
      assert.equal(r.reason, reason, String(input).slice(0, 60));
      assert.ok(!r.message.includes("§"));
    }
  }
  const scheme = validateWebhookUrlForm("http://x.example.com");
  assert.equal(!scheme.ok && scheme.message, "Webhook URLs must use https on port 443");
  const blocked = validateWebhookUrlForm("https://10.0.0.1/");
  assert.equal(!blocked.ok && blocked.message, "This address is on a private or internal network");
  assert.equal(validateWebhookUrlForm("https://8.8.8.8/hook").ok, true, "a public IP literal passes the form check");
});

test("URL hint is host + last 4 characters, never the secret path or query", () => {
  const hint = webhookUrlHint(TEAMS_URL);
  assert.equal(hint, "prod-12.westeurope.logic.azure.com …x9Zq");
  assert.ok(!hint.includes("sig="));
  assert.ok(!hint.includes("workflows"));
});

test("create / patch body validation", () => {
  const ns = "6f1c2b9e-1d2a-4c3b-9a8b-0c1d2e3f4a5b";
  const ok = parseWebhookCreate({ namespaceId: ns, name: "  Team channel ", format: "teams_workflows", url: TEAMS_URL });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.value.name, "Team channel");
    assert.equal(ok.value.enabled, true, "enabled defaults to true");
  }
  assert.equal(parseWebhookCreate({ namespaceId: "nope", name: "a", format: "json", url: TEAMS_URL }).ok, false);
  assert.equal(parseWebhookCreate({ namespaceId: ns, name: "", format: "json", url: TEAMS_URL }).ok, false);
  assert.equal(parseWebhookCreate({ namespaceId: ns, name: "x".repeat(81), format: "json", url: TEAMS_URL }).ok, false);
  assert.equal(parseWebhookCreate({ namespaceId: ns, name: "x".repeat(80), format: "json", url: TEAMS_URL }).ok, true);
  assert.equal(parseWebhookCreate({ namespaceId: ns, name: "a", format: "slack", url: TEAMS_URL }).ok, false);
  assert.equal(parseWebhookCreate({ namespaceId: ns, name: "a", format: "json", url: "" }).ok, false);
  assert.equal(parseWebhookCreate({ namespaceId: ns, name: "a", format: "json", url: TEAMS_URL, enabled: "yes" }).ok, false);

  const keep = parseWebhookPatch({ url: "", enabled: false });
  assert.ok(keep.ok);
  if (keep.ok) assert.deepEqual(keep.value, { enabled: false }, "an empty URL keeps the stored one");
  const replace = parseWebhookPatch({ url: TEAMS_URL, name: "New", format: "json" });
  assert.ok(replace.ok);
  if (replace.ok) assert.deepEqual(replace.value, { url: TEAMS_URL, name: "New", format: "json" });
  assert.equal(parseWebhookPatch({ enabled: "on" }).ok, false);
  assert.equal(parseWebhookPatch({ format: "xml" }).ok, false);
  assert.equal(parseWebhookPatch({ url: 7 }).ok, false);
});

test("leak guard: only org-visible items pass", () => {
  assert.equal(isOrgVisibleWebhookItem({ challengeVisibility: "org", challengeStatus: "valid" }), true);
  assert.equal(isOrgVisibleWebhookItem({ challengeVisibility: "org", challengeStatus: "solved" }), true);
  assert.equal(isOrgVisibleWebhookItem({ challengeVisibility: "namespace", challengeStatus: "valid" }), false);
  assert.equal(isOrgVisibleWebhookItem({ challengeVisibility: "org", challengeStatus: "awaiting_triage" }), false);
  assert.equal(isOrgVisibleWebhookItem({ challengeVisibility: "org", challengeStatus: "withdrawn" }), false);
  assert.equal(isOrgVisibleWebhookItem({ challengeVisibility: "org", challengeStatus: "solved", solutionStatus: "implemented" }), true);
  assert.equal(isOrgVisibleWebhookItem({ challengeVisibility: "org", challengeStatus: "valid", solutionStatus: "proposed" }), false);
  assert.equal(isOrgVisibleWebhookItem({ challengeVisibility: "org", challengeStatus: "valid", solutionStatus: "withdrawn" }), false);
  assert.equal(isOrgVisibleWebhookItem({ challengeVisibility: "namespace", challengeStatus: "solved", solutionStatus: "implemented" }), false);
});

const challengeMsg: WebhookMessage = {
  event: "challenge.validated",
  occurredAt: "2026-10-08T12:34:56.789Z",
  namespace: "global",
  item: { type: "challenge", number: "CH-42", title: "Reduce onboarding time for new joiners", status: "valid", url: webhookItemUrl("https://innobox.example.test/", 42) },
};

test("generic JSON payload: exactly the specified fields, no person field", () => {
  const p = buildJsonPayload(challengeMsg);
  assert.deepEqual(p, {
    schema: "innobox.webhook.v1",
    event: "challenge.validated",
    occurredAt: "2026-10-08T12:34:56Z",
    namespace: "global",
    item: { type: "challenge", number: "CH-42", title: "Reduce onboarding time for new joiners", status: "valid", url: "https://innobox.example.test/challenges/42" },
  });
  const text = JSON.stringify(p);
  for (const forbidden of ["author", "assignee", "coauthor", "email", "displayName"]) assert.ok(!text.includes(forbidden), forbidden);
});

test("solution item URL uses the #SOL anchor", () => {
  assert.equal(webhookItemUrl("https://innobox.example.test", 42, 7), "https://innobox.example.test/challenges/42#SOL-7");
});

test("Teams Workflows payload: message envelope, Adaptive Card 1.4, title as a plain TextRun", () => {
  const md: WebhookMessage = { ...challengeMsg, item: { ...challengeMsg.item, title: "Click [here](https://evil.example) **now**" } };
  const p = buildTeamsPayload(md) as { type: string; attachments: { contentType: string; contentUrl: null; content: Record<string, unknown> }[] };
  assert.equal(p.type, "message");
  assert.equal(p.attachments.length, 1);
  const att = p.attachments[0]!;
  assert.equal(att.contentType, "application/vnd.microsoft.card.adaptive");
  assert.equal(att.contentUrl, null);
  const card = att.content as { type: string; version: string; body: Record<string, unknown>[]; actions: Record<string, unknown>[] };
  assert.equal(card.type, "AdaptiveCard");
  assert.equal(card.version, "1.4");
  assert.deepEqual(card.body[0], { type: "TextBlock", text: "New challenge open for solutions", weight: "Bolder", size: "Medium", wrap: true });
  assert.deepEqual(card.body[1], { type: "RichTextBlock", inlines: [{ type: "TextRun", text: "CH-42 · Click [here](https://evil.example) **now**" }] });
  assert.deepEqual(card.body[2], {
    type: "FactSet",
    facts: [
      { title: "Status", value: "Valid — open for solutions" },
      { title: "Namespace", value: "global" },
    ],
  });
  assert.deepEqual(card.body[3], {
    type: "TextBlock",
    text: "{{DATE(2026-10-08T12:34:56Z,SHORT)}} {{TIME(2026-10-08T12:34:56Z)}}",
    isSubtle: true,
    size: "Small",
    wrap: true,
  });
  // The title never lands in a Markdown-capable TextBlock.
  for (const block of card.body.filter((b) => b.type === "TextBlock")) assert.ok(!String(block.text).includes("evil.example"));
  assert.deepEqual(card.actions, [{ type: "Action.OpenUrl", title: "Open in InnoBox", url: "https://innobox.example.test/challenges/42" }]);
});

test("Teams headings and status labels per event; the test message", () => {
  const heading = (event: WebhookMessage["event"], status: string) => {
    const card = (buildTeamsPayload({ ...challengeMsg, event, item: { ...challengeMsg.item, status } }) as { attachments: { content: { body: { text?: string; facts?: { value: string }[] }[] } }[] }).attachments[0]!.content;
    return [card.body[0]!.text, card.body[2]!.facts![0]!.value];
  };
  assert.deepEqual(heading("solution.implemented", "implemented"), ["Solution implemented", "Implemented"]);
  assert.deepEqual(heading("challenge.solved", "solved"), ["Challenge solved", "Solved"]);
  const test = buildTestWebhookMessage("https://innobox.example.test/", "global", new Date("2026-10-08T10:00:00.500Z"));
  assert.deepEqual(buildJsonPayload(test), {
    schema: "innobox.webhook.v1",
    event: "test",
    occurredAt: "2026-10-08T10:00:00Z",
    namespace: "global",
    item: { type: "challenge", number: "CH-0", title: "Test message from InnoBox", status: "valid", url: "https://innobox.example.test" },
  });
  assert.deepEqual(heading("test", "valid")[0], "Test message — this channel is connected to InnoBox");
});

test("rendered body stays ≤ 16 KB even for a pathological title", () => {
  const huge: WebhookMessage = { ...challengeMsg, item: { ...challengeMsg.item, title: "€".repeat(20_000) } };
  for (const format of ["json", "teams_workflows"] as const) {
    const body = renderWebhookBody(format, huge);
    assert.ok(Buffer.byteLength(body) <= WEBHOOK_BODY_MAX_BYTES, format);
    JSON.parse(body);
  }
  assert.equal(JSON.parse(renderWebhookBody("json", challengeMsg)).item.title, challengeMsg.item.title, "a normal title is untouched");
});

test("headers", () => {
  assert.deepEqual(webhookHeaders("challenge.solved", "d-1", "0.36.0"), {
    "user-agent": "InnoBox-Webhook/0.36.0",
    "x-innobox-event": "challenge.solved",
    "x-innobox-delivery": "d-1",
  });
});

test("status classification: 2xx sent, 408/429/5xx retry, 3xx and other 4xx permanent", () => {
  for (const s of [200, 202, 204]) assert.equal(classifyWebhookHttpStatus(s), "sent");
  for (const s of [408, 429, 500, 502, 503, 599]) assert.equal(classifyWebhookHttpStatus(s), "retryable");
  for (const s of [301, 302, 307, 308, 400, 401, 403, 404, 410, 413]) assert.equal(classifyWebhookHttpStatus(s), "permanent");
});

test("backoff: 1m, 5m, 15m, 1h, 4h then give up after the 6th attempt; Retry-After honoured, capped", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => webhookRetryDelayMs(n)), [60_000, 300_000, 900_000, 3_600_000, 14_400_000]);
  assert.equal(webhookRetryDelayMs(WEBHOOK_MAX_ATTEMPTS), null);
  assert.equal(webhookRetryDelayMs(7), null);
  assert.equal(webhookRetryDelayMs(1, 30_000), 60_000, "a shorter Retry-After never shortens the step");
  assert.equal(webhookRetryDelayMs(1, 120_000), 120_000, "a longer Retry-After wins");
  assert.equal(webhookRetryDelayMs(2, 24 * 3_600_000), 14_400_000, "capped at 4 h");
  assert.equal(parseRetryAfterMs("120", 0), 120_000);
  assert.equal(parseRetryAfterMs("Thu, 08 Oct 2026 12:01:00 GMT", Date.parse("2026-10-08T12:00:00Z")), 60_000);
  assert.equal(parseRetryAfterMs("soon", 0), null);
  assert.equal(parseRetryAfterMs(undefined, 0), null);
});

test("final-failure system-log row: synthetic 502/504, fixed codes, never the URL", () => {
  const base = { webhookName: "Team channel", namespaceSlug: "global", event: "challenge.validated" as const, itemNumber: "CH-42" };
  const http = webhookFailureSystemEvent({ ...base, reason: "http_error", httpStatus: 404 });
  assert.deepEqual(
    { status: http.status, method: http.method, route: http.route, path: http.path, errorCode: http.errorCode },
    { status: 404, method: "POST", route: "/webhooks/[namespace]", path: "/webhooks/global", errorCode: "webhook_http_error" },
  );
  assert.ok(http.message.includes("Team channel") && http.message.includes("challenge.validated") && http.message.includes("CH-42"));
  assert.equal(webhookFailureSystemEvent({ ...base, reason: "timeout", httpStatus: null }).status, 504);
  for (const reason of ["network", "dns", "blocked_address", "undecryptable", "key_missing"] as const) {
    const e = webhookFailureSystemEvent({ ...base, reason, httpStatus: null });
    assert.equal(e.status, 502, reason);
    assert.ok(e.errorCode.startsWith("webhook_"));
    assert.ok(!e.message.includes("https://"));
  }
  assert.equal(webhookFailureSystemEvent({ ...base, reason: "redirect", httpStatus: 302 }).errorCode, "webhook_redirect");
  assert.equal(webhookReasonText("undecryptable", null), "stored URL can't be decrypted — re-enter it");
  assert.equal(webhookReasonText("http_error", 404), "receiver answered HTTP 404");
});

test("card labels: latest delivery and Send test result", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  assert.equal(webhookLastDeliveryLabel(null, now), "No deliveries yet");
  assert.equal(webhookLastDeliveryLabel({ outcome: "sent", at: "2026-10-08T11:55:00Z", httpStatus: 202, reason: null }, now), "Delivered 5 min ago");
  assert.equal(
    webhookLastDeliveryLabel({ outcome: "failed", at: "2026-10-08T10:00:00Z", httpStatus: 404, reason: "http_error" }, now),
    "Failed 2 h ago — receiver answered HTTP 404",
  );
  assert.equal(webhookLastDeliveryLabel({ outcome: "sent", at: "2026-10-05T12:00:00Z", httpStatus: 202, reason: null }, now), "Delivered 3 d ago");
  assert.equal(webhookTestResultLabel({ ok: true, httpStatus: 202, durationMs: 840 }), "Delivered — HTTP 202 in 840 ms");
  assert.equal(webhookTestResultLabel({ ok: false, httpStatus: 404, reason: "http_error", durationMs: 30 }), "Failed — receiver answered HTTP 404");
  assert.equal(webhookTestResultLabel({ ok: false, reason: "timeout", durationMs: 10_000 }), "Failed — no answer within 10 s");
});

// Channel webhooks (INNOBOX_SPEC.md §12.4) — the pure, CLIENT-SAFE half: vocabulary, input
// validation, the URL form rules and hint, the org-visible leak-guard predicate, both payload
// formats, the retry schedule, and the reason/system-log mapping. Also exposed at the
// `@innobox/shared/webhooks` subpath for the Administration card. The transport (DNS, pinned
// HTTPS, AES-GCM) is server-only and lives in `webhook-send.ts`.
//
// Anonymity is structural (invariant 3): no type here has a person field, so no payload can
// carry an author, co-author, assignee or any other identity.
import { ipLiteralFamily, isPublicAddress } from "./webhook-address.js";

export const WEBHOOK_EVENTS = ["challenge.validated", "solution.implemented", "challenge.solved"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_FORMATS = ["json", "teams_workflows"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];
export const WEBHOOK_FORMAT_LABEL: Record<WebhookFormat, string> = { json: "JSON", teams_workflows: "Teams Workflows" };

export const WEBHOOK_SCHEMA = "innobox.webhook.v1";
export const WEBHOOK_NAME_MAX = 80;
export const WEBHOOK_URL_MAX = 2048;
export const WEBHOOKS_PER_NAMESPACE_MAX = 5;
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_BODY_MAX_BYTES = 16 * 1024;
export const WEBHOOK_RESPONSE_READ_MAX_BYTES = 64 * 1024;
export const WEBHOOK_SWEEP_BATCH = 50;
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;
/** Six attempts in all: the first, then retries after 1 min, 5 min, 15 min, 1 h, 4 h. */
export const WEBHOOK_MAX_ATTEMPTS = 6;
export const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [60_000, 300_000, 900_000, 3_600_000, 14_400_000];
export const WEBHOOK_RETRY_AFTER_CAP_MS = 14_400_000;

export function isWebhookFormat(v: unknown): v is WebhookFormat {
  return typeof v === "string" && (WEBHOOK_FORMATS as readonly string[]).includes(v);
}

export function isWebhookEvent(v: unknown): v is WebhookEvent {
  return typeof v === "string" && (WEBHOOK_EVENTS as readonly string[]).includes(v);
}

// ── URL form rules + hint ────────────────────────────────────────────────────────────────

export type WebhookUrlFormReason = "invalid_url" | "scheme" | "userinfo" | "too_long" | "blocked_address";

export const WEBHOOK_URL_MESSAGES: Record<WebhookUrlFormReason | "dns", string> = {
  invalid_url: "Enter a complete webhook URL, starting with https://",
  scheme: "Webhook URLs must use https on port 443",
  userinfo: "Webhook URLs must not contain a user name or password",
  too_long: `Webhook URLs must be at most ${WEBHOOK_URL_MAX} characters`,
  blocked_address: "This address is on a private or internal network",
  dns: "This address could not be resolved",
};

export type WebhookUrlForm = { ok: true; url: string; hostname: string } | { ok: false; reason: WebhookUrlFormReason; message: string };

/** The save-time AND send-time form check: https only, port 443 (implicit or explicit), no
 *  userinfo, ≤ 2 048 characters, a valid absolute URL. An IP-literal host is judged here too
 *  (no DNS needed); host names are judged after resolution by the transport. */
export function validateWebhookUrlForm(raw: unknown): WebhookUrlForm {
  const fail = (reason: WebhookUrlFormReason): WebhookUrlForm => ({ ok: false, reason, message: WEBHOOK_URL_MESSAGES[reason] });
  if (typeof raw !== "string") return fail("invalid_url");
  const text = raw.trim();
  if (text === "") return fail("invalid_url");
  if (text.length > WEBHOOK_URL_MAX) return fail("too_long");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail("invalid_url");
  }
  if (url.protocol !== "https:") return fail("scheme");
  // WHATWG URL normalises an explicit :443 on https to "" — anything else is another port.
  if (url.port !== "") return fail("scheme");
  if (url.username !== "" || url.password !== "") return fail("userinfo");
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (hostname === "") return fail("invalid_url");
  if (ipLiteralFamily(hostname) !== 0 && !isPublicAddress(hostname)) return fail("blocked_address");
  return { ok: true, url: text, hostname };
}

/** The plaintext hint stored next to the ciphertext: host + the URL's last 4 characters. */
export function webhookUrlHint(url: string): string {
  const text = url.trim();
  let host = "";
  try {
    host = new URL(text).host;
  } catch {
    /* validated before this is called */
  }
  return `${host} …${text.slice(-4)}`;
}

// ── Request-body validation (admin API) ──────────────────────────────────────────────────

export type WebhookResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface WebhookCreateInput {
  namespaceId: string;
  name: string;
  format: WebhookFormat;
  url: string;
  enabled: boolean;
}

export interface WebhookPatchInput {
  name?: string;
  format?: WebhookFormat;
  /** Absent or empty keeps the stored URL; a value replaces it. */
  url?: string;
  enabled?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseName(v: unknown): WebhookResult<string> {
  if (typeof v !== "string" || v.trim() === "") return { ok: false, error: "name is required" };
  const name = v.trim();
  if (name.length > WEBHOOK_NAME_MAX) return { ok: false, error: `name must be at most ${WEBHOOK_NAME_MAX} characters` };
  return { ok: true, value: name };
}

/** Shape checks only (400s). URL rules are judged separately (422) by `validateWebhookUrlForm`
 *  and the transport's DNS vetting. */
export function parseWebhookCreate(body: Record<string, unknown>): WebhookResult<WebhookCreateInput> {
  if (typeof body.namespaceId !== "string" || !UUID_RE.test(body.namespaceId)) return { ok: false, error: "namespaceId must be a uuid" };
  const name = parseName(body.name);
  if (!name.ok) return name;
  if (!isWebhookFormat(body.format)) return { ok: false, error: "format must be json or teams_workflows" };
  if (typeof body.url !== "string" || body.url.trim() === "") return { ok: false, error: "url is required" };
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
  return { ok: true, value: { namespaceId: body.namespaceId, name: name.value, format: body.format, url: body.url.trim(), enabled: body.enabled ?? true } };
}

export function parseWebhookPatch(body: Record<string, unknown>): WebhookResult<WebhookPatchInput> {
  const out: WebhookPatchInput = {};
  if (body.name !== undefined) {
    const name = parseName(body.name);
    if (!name.ok) return name;
    out.name = name.value;
  }
  if (body.format !== undefined) {
    if (!isWebhookFormat(body.format)) return { ok: false, error: "format must be json or teams_workflows" };
    out.format = body.format;
  }
  if (body.url !== undefined && body.url !== null) {
    if (typeof body.url !== "string") return { ok: false, error: "url must be a string" };
    if (body.url.trim() !== "") out.url = body.url.trim();
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
    out.enabled = body.enabled;
  }
  return { ok: true, value: out };
}

// ── Leak guard (invariants 2–3) ──────────────────────────────────────────────────────────

/** The §13.5 org-visible test an arbitrary authenticated viewer would pass: the challenge (or a
 *  solution's parent) is `org`-visible and neither `awaiting_triage` nor `withdrawn`; a solution
 *  is additionally neither `proposed` nor `withdrawn`. Run at enqueue AND before every send. */
export function isOrgVisibleWebhookItem(item: { challengeVisibility: string; challengeStatus: string; solutionStatus?: string | null }): boolean {
  if (item.challengeVisibility !== "org") return false;
  if (item.challengeStatus === "awaiting_triage" || item.challengeStatus === "withdrawn") return false;
  if (item.solutionStatus != null && (item.solutionStatus === "proposed" || item.solutionStatus === "withdrawn")) return false;
  return true;
}

// ── Payloads ─────────────────────────────────────────────────────────────────────────────

export interface WebhookItem {
  type: "challenge" | "solution";
  number: string;
  title: string;
  status: string;
  url: string;
}

export interface WebhookMessage {
  event: WebhookEvent | "test";
  /** UTC ISO; rendered at second precision. */
  occurredAt: string;
  namespace: string;
  item: WebhookItem;
}

export const WEBHOOK_HEADINGS: Record<WebhookEvent | "test", string> = {
  "challenge.validated": "New challenge open for solutions",
  "solution.implemented": "Solution implemented",
  "challenge.solved": "Challenge solved",
  test: "Test message — this channel is connected to InnoBox",
};

/** The §7.1/§8.1 display labels of the statuses a webhook can be about. */
const STATUS_DISPLAY: Record<string, string> = {
  valid: "Valid — open for solutions",
  implemented: "Implemented",
  solved: "Solved",
};

export function webhookStatusLabel(status: string): string {
  return STATUS_DISPLAY[status] ?? status;
}

/** Second-precision UTC ISO (`2026-10-08T12:34:56Z`). */
export function webhookTimestamp(at: string | Date): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The §12.1 deep-link convention under PUBLIC_BASE_URL: `/challenges/<n>`, a solution as
 *  `/challenges/<n>#SOL-<m>`. */
export function webhookItemUrl(baseUrl: string, challengeNumber: string | number, solutionNumber?: string | number | null): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/challenges/${challengeNumber}${solutionNumber != null ? `#SOL-${solutionNumber}` : ""}`;
}

/** The fixed synthetic message of the Send test action — no real item data. */
export function buildTestWebhookMessage(baseUrl: string, namespaceSlug: string, now: Date): WebhookMessage {
  return {
    event: "test",
    occurredAt: webhookTimestamp(now),
    namespace: namespaceSlug,
    item: { type: "challenge", number: "CH-0", title: "Test message from InnoBox", status: "valid", url: baseUrl.replace(/\/+$/, "") || baseUrl },
  };
}

/** Generic JSON: exactly these fields. */
export function buildJsonPayload(msg: WebhookMessage): Record<string, unknown> {
  return {
    schema: WEBHOOK_SCHEMA,
    event: msg.event,
    occurredAt: webhookTimestamp(msg.occurredAt),
    namespace: msg.namespace,
    item: { type: msg.item.type, number: msg.item.number, title: msg.item.title, status: msg.item.status, url: msg.item.url },
  };
}

/** Teams Workflows ("Post to a channel when a webhook request is received"): a `message`
 *  envelope around one Adaptive Card 1.4. User text is NEVER Markdown — the title travels only
 *  as a TextRun inside a RichTextBlock (rendered as plain text), and the only actionable
 *  element is the Action.OpenUrl under PUBLIC_BASE_URL. */
export function buildTeamsPayload(msg: WebhookMessage): Record<string, unknown> {
  const at = webhookTimestamp(msg.occurredAt);
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: WEBHOOK_HEADINGS[msg.event], weight: "Bolder", size: "Medium", wrap: true },
            { type: "RichTextBlock", inlines: [{ type: "TextRun", text: `${msg.item.number} · ${msg.item.title}` }] },
            {
              type: "FactSet",
              facts: [
                { title: "Status", value: webhookStatusLabel(msg.item.status) },
                { title: "Namespace", value: msg.namespace },
              ],
            },
            { type: "TextBlock", text: `{{DATE(${at},SHORT)}} {{TIME(${at})}}`, isSubtle: true, size: "Small", wrap: true },
          ],
          actions: [{ type: "Action.OpenUrl", title: "Open in InnoBox", url: msg.item.url }],
        },
      },
    ],
  };
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** The request body for `format`, kept ≤ 16 KB: an over-long title is shortened (with an
 *  ellipsis) until it fits — the only free-text field in either payload. */
export function renderWebhookBody(format: WebhookFormat, msg: WebhookMessage): string {
  const build = format === "teams_workflows" ? buildTeamsPayload : buildJsonPayload;
  let title = msg.item.title;
  for (;;) {
    const body = JSON.stringify(build({ ...msg, item: { ...msg.item, title } }));
    if (byteLength(body) <= WEBHOOK_BODY_MAX_BYTES || title.length === 0) return body;
    title = `${title.slice(0, Math.floor(title.length / 2))}…`;
    if (title.length <= 1) title = "";
  }
}

export function webhookHeaders(event: WebhookEvent | "test", deliveryId: string, appVersion: string): Record<string, string> {
  return {
    "user-agent": `InnoBox-Webhook/${appVersion}`,
    "x-innobox-event": event,
    "x-innobox-delivery": deliveryId,
  };
}

// ── Outcomes, retries, reasons ───────────────────────────────────────────────────────────

/** Fixed reason codes — the only failure text ever stored, never a library message that might
 *  echo the URL. */
export type WebhookFailureReason =
  | "http_error"
  | "redirect"
  | "timeout"
  | "network"
  | "dns"
  | "blocked_address"
  | "invalid_url"
  | "undecryptable"
  | "key_missing";
export type WebhookSkipReason = "disabled" | "not_visible";

export type HttpOutcome = "sent" | "retryable" | "permanent";

/** 2xx success; 408, 429 and 5xx retry; every 3xx (never followed) and other 4xx fail for good. */
export function classifyWebhookHttpStatus(status: number): HttpOutcome {
  if (status >= 200 && status < 300) return "sent";
  if (status === 408 || status === 429 || (status >= 500 && status < 600)) return "retryable";
  return "permanent";
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date; null when absent or unparsable. */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number): number | null {
  if (!header) return null;
  const text = header.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/** The delay before the next attempt after `attemptsMade` failed attempts, or null when the
 *  6-attempt budget is spent. A 429's Retry-After wins when longer than the step, capped at 4 h. */
export function webhookRetryDelayMs(attemptsMade: number, retryAfterMs?: number | null): number | null {
  if (attemptsMade >= WEBHOOK_MAX_ATTEMPTS || attemptsMade < 1) return null;
  const step = WEBHOOK_RETRY_DELAYS_MS[attemptsMade - 1]!;
  if (retryAfterMs != null && retryAfterMs > step) return Math.min(retryAfterMs, WEBHOOK_RETRY_AFTER_CAP_MS);
  return step;
}

/** One plain sentence for a failure, never containing the URL. */
export function webhookReasonText(reason: string | null | undefined, httpStatus: number | null | undefined): string {
  switch (reason) {
    case "http_error":
      return `receiver answered HTTP ${httpStatus ?? "error"}`;
    case "redirect":
      return `receiver answered with a redirect (HTTP ${httpStatus ?? "3xx"}), which is not followed`;
    case "timeout":
      return "no answer within 10 s";
    case "network":
      return "could not connect to the receiver";
    case "dns":
      return "the receiver's address could not be resolved";
    case "blocked_address":
    case "invalid_url":
      return "the address is on a private or internal network";
    case "undecryptable":
      return "stored URL can't be decrypted — re-enter it";
    case "key_missing":
      return "webhooks are not configured on this server";
    case "disabled":
      return "the webhook was disabled";
    case "not_visible":
      return "the item is no longer visible to everyone";
    default:
      return httpStatus ? `receiver answered HTTP ${httpStatus}` : "delivery failed";
  }
}

export const WEBHOOK_SYSTEM_LOG_ROUTE = "/webhooks/[namespace]";

const SYSTEM_ERROR_CODE: Record<WebhookFailureReason, string> = {
  http_error: "webhook_http_error",
  redirect: "webhook_redirect",
  timeout: "webhook_timeout",
  network: "webhook_network",
  dns: "webhook_network",
  blocked_address: "webhook_blocked_address",
  invalid_url: "webhook_blocked_address",
  undecryptable: "webhook_undecryptable",
  key_missing: "webhook_key_missing",
};

/** The §14.7 row for a final delivery failure (`source = worker`, no user): the receiver's
 *  status when one came back, else 504 for a timeout and 502 for any other no-response failure;
 *  the message names the webhook, the event and the item number — never the URL. */
export function webhookFailureSystemEvent(input: {
  webhookName: string;
  namespaceSlug: string;
  event: WebhookEvent;
  itemNumber: string;
  reason: WebhookFailureReason;
  httpStatus: number | null;
}): { status: number; method: string; route: string; path: string; errorCode: string; message: string } {
  const status = input.httpStatus ?? (input.reason === "timeout" ? 504 : 502);
  return {
    status,
    method: "POST",
    route: WEBHOOK_SYSTEM_LOG_ROUTE,
    path: `/webhooks/${input.namespaceSlug}`,
    errorCode: SYSTEM_ERROR_CODE[input.reason],
    message: `Webhook "${input.webhookName}" could not deliver ${input.event} for ${input.itemNumber}: ${webhookReasonText(input.reason, input.httpStatus)}`,
  };
}

// ── Administration card labels ───────────────────────────────────────────────────────────

/** "just now", "5 min ago", "2 h ago", "3 d ago" — a coarse relative age for the card. */
export function webhookAgo(iso: string, nowMs: number): string {
  const mins = Math.floor(Math.max(0, nowMs - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** The per-webhook latest-delivery line: "Delivered 5 min ago", "Failed 2 h ago — receiver
 *  answered HTTP 404", "No deliveries yet". */
export function webhookLastDeliveryLabel(
  last: { outcome: "sent" | "failed"; at: string; httpStatus: number | null; reason: string | null } | null,
  nowMs: number,
): string {
  if (!last) return "No deliveries yet";
  if (last.outcome === "sent") return `Delivered ${webhookAgo(last.at, nowMs)}`;
  return `Failed ${webhookAgo(last.at, nowMs)} — ${webhookReasonText(last.reason, last.httpStatus)}`;
}

/** The Send test's inline result: "Delivered — HTTP 202 in 840 ms" / "Failed — receiver
 *  answered HTTP 404". */
export function webhookTestResultLabel(result: { ok: boolean; httpStatus?: number; reason?: string; durationMs: number }): string {
  if (result.ok) return `Delivered — HTTP ${result.httpStatus} in ${result.durationMs} ms`;
  return `Failed — ${webhookReasonText(result.reason, result.httpStatus)}`;
}

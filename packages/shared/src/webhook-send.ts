// Channel-webhook transport (INNOBOX_SPEC.md §12.4, §2.4 *Outbound requests*) — SERVER-ONLY
// (node:dns, node:https, node:crypto). Import via "@innobox/shared/webhook-send"; never from a
// client component. Shared by the web tier (save-time vetting, the synchronous Send test) and
// the worker's delivery sweep, so both apply the identical guard:
//
//   - https on 443 only, no userinfo, ≤ 2 048 chars (validateWebhookUrlForm);
//   - the host is resolved (A + AAAA) and refused if ANY address is not public;
//   - the connection is PINNED to the vetted address (a custom `lookup` that never resolves
//     again — no DNS rebinding window); the original host name stays the SNI / Host / certificate
//     name, and TLS verification is always on;
//   - proxy environment variables are not honoured: a dedicated https.Agent is used (Node only
//     wires HTTP(S)_PROXY into the global agent), so a proxy can never sit between the guard
//     and the receiver;
//   - no redirects (a 3xx is a failure, Location never followed); 10 s for the whole exchange;
//     the response body is read up to 64 KB and discarded.
//
// Error results carry FIXED reason codes only — never `err.message`, which might echo the URL.
import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { LookupFunction } from "node:net";
import { decryptToken, encryptToken, parseEmailTokenKey } from "./email-crypto.js";
import { ipLiteralFamily, isPublicAddress } from "./webhook-address.js";
import {
  WEBHOOK_RESPONSE_READ_MAX_BYTES,
  WEBHOOK_TIMEOUT_MS,
  WEBHOOK_URL_MESSAGES,
  classifyWebhookHttpStatus,
  parseRetryAfterMs,
  validateWebhookUrlForm,
  type WebhookFailureReason,
  type WebhookUrlFormReason,
} from "./webhooks.js";

export const WEBHOOK_ENC_KEY_ENV = "WEBHOOK_ENC_KEY";

// ── At-rest encryption: the §12.1 `v1:iv:tag:ct` AES-256-GCM helper, under its OWN key ─────

/** WEBHOOK_ENC_KEY (32 bytes, base64). null when unset/invalid — webhooks are then off. */
export function parseWebhookKey(keyB64: string | undefined): Buffer | null {
  return parseEmailTokenKey(keyB64);
}

export function encryptWebhookUrl(url: string, key: Buffer): string {
  return encryptToken(url, key);
}

/** null when the ciphertext no longer decrypts (key rotated, tampered, malformed). */
export function decryptWebhookUrl(enc: string, key: Buffer): string | null {
  try {
    return decryptToken(enc, key);
  } catch {
    return null;
  }
}

// ── DNS vetting ──────────────────────────────────────────────────────────────────────────

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type WebhookResolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** getaddrinfo with both families (A and AAAA), every address returned. */
export const defaultWebhookResolver: WebhookResolver = async (hostname) => {
  const all = await dnsLookup(hostname, { all: true, verbatim: true });
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

export type WebhookVetResult =
  | { ok: true; hostname: string; url: URL; address: ResolvedAddress }
  | { ok: false; reason: WebhookUrlFormReason | "dns"; message: string };


/** The form rules, then the address check after resolution: refused when ANY resolved address
 *  is not public. Returns the one vetted address the connection will be pinned to. */
export async function vetWebhookUrl(raw: string, resolve: WebhookResolver = defaultWebhookResolver): Promise<WebhookVetResult> {
  const form = validateWebhookUrlForm(raw);
  if (!form.ok) return { ok: false, reason: form.reason, message: form.message };
  const url = new URL(form.url);
  const literal = ipLiteralFamily(form.hostname);
  if (literal !== 0) {
    // Already judged public by the form check.
    return { ok: true, hostname: form.hostname, url, address: { address: form.hostname, family: literal } };
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(form.hostname);
  } catch {
    return { ok: false, reason: "dns", message: WEBHOOK_URL_MESSAGES.dns };
  }
  if (addresses.length === 0) return { ok: false, reason: "dns", message: WEBHOOK_URL_MESSAGES.dns };
  if (addresses.some((a) => !isPublicAddress(a.address))) {
    return { ok: false, reason: "blocked_address", message: WEBHOOK_URL_MESSAGES.blocked_address };
  }
  return { ok: true, hostname: form.hostname, url, address: addresses[0]! };
}

// ── Send ─────────────────────────────────────────────────────────────────────────────────

export type WebhookSendResult =
  | { outcome: "sent"; httpStatus: number; durationMs: number }
  | {
      outcome: "retryable" | "permanent";
      reason: WebhookFailureReason;
      httpStatus: number | null;
      /** A 429's Retry-After, when present. */
      retryAfterMs: number | null;
      durationMs: number;
    };

/** The request primitive, injectable so tests can drive a local server — never the internet. */
export type WebhookRequestFn = (options: https.RequestOptions, onResponse: (res: IncomingMessage) => void) => ClientRequest;

export interface WebhookSendDeps {
  resolve?: WebhookResolver;
  request?: WebhookRequestFn;
  timeoutMs?: number;
  now?: () => number;
}

export interface WebhookSendInput {
  url: string;
  body: string;
  /** Extra headers (User-Agent, X-InnoBox-Event, X-InnoBox-Delivery). */
  headers: Record<string, string>;
}

/** One attempt: vet, connect to the vetted address, POST, classify. Never throws. */
export async function sendWebhook(input: WebhookSendInput, deps: WebhookSendDeps = {}): Promise<WebhookSendResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const elapsed = () => Math.max(0, now() - started);
  const failure = (outcome: "retryable" | "permanent", reason: WebhookFailureReason, httpStatus: number | null = null, retryAfterMs: number | null = null): WebhookSendResult => ({
    outcome,
    reason,
    httpStatus,
    retryAfterMs,
    durationMs: elapsed(),
  });

  const vet = await vetWebhookUrl(input.url, deps.resolve ?? defaultWebhookResolver);
  if (!vet.ok) {
    // A DNS failure is retryable (it fails for good only on the final attempt); a refused
    // address or a form violation is permanent.
    if (vet.reason === "dns") return failure("retryable", "dns");
    return failure("permanent", vet.reason === "blocked_address" ? "blocked_address" : "invalid_url");
  }

  const { url, hostname, address } = vet;
  const pinned: LookupFunction = (_host, options, callback) => {
    const cb = callback as (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;
    if ((options as { all?: boolean } | undefined)?.all) cb(null, [{ address: address.address, family: address.family }]);
    else cb(null, address.address, address.family);
  };
  const isLiteral = ipLiteralFamily(hostname) !== 0;
  const timeoutMs = deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const request = deps.request ?? (https.request as unknown as WebhookRequestFn);

  return new Promise<WebhookSendResult>((resolve) => {
    let settled = false;
    let status: number | null = null;
    let retryAfterHeader: string | null = null;
    const finish = (result: WebhookSendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const byStatus = (): WebhookSendResult => {
      const s = status!;
      const kind = classifyWebhookHttpStatus(s);
      if (kind === "sent") return { outcome: "sent", httpStatus: s, durationMs: elapsed() };
      const reason: WebhookFailureReason = s >= 300 && s < 400 ? "redirect" : "http_error";
      return failure(kind, reason, s, s === 429 ? parseRetryAfterMs(retryAfterHeader, now()) : null);
    };

    let req: ClientRequest | undefined;
    const timer = setTimeout(() => {
      // Headers already in → the status decides; otherwise it is a timeout.
      finish(status !== null ? byStatus() : failure("retryable", "timeout"));
      req?.destroy();
    }, timeoutMs);

    try {
      req = request(
        {
          protocol: "https:",
          hostname,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: "POST",
          headers: {
            ...input.headers,
            host: url.host,
            "content-type": "application/json; charset=utf-8",
            "content-length": String(Buffer.byteLength(input.body)),
          },
          lookup: pinned,
          servername: isLiteral ? undefined : hostname,
          rejectUnauthorized: true,
          agent: new https.Agent({ keepAlive: false }),
        },
        (res) => {
          status = res.statusCode ?? 0;
          const ra = res.headers["retry-after"];
          retryAfterHeader = typeof ra === "string" ? ra : null;
          let read = 0;
          res.on("data", (chunk: Buffer) => {
            read += chunk.length;
            if (read > WEBHOOK_RESPONSE_READ_MAX_BYTES) {
              finish(byStatus());
              res.destroy();
            }
          });
          res.on("end", () => finish(byStatus()));
          res.on("close", () => finish(byStatus()));
          res.on("error", () => finish(byStatus()));
        },
      );
    } catch {
      finish(failure("retryable", "network"));
      return;
    }
    req.on("error", () => finish(status !== null ? byStatus() : failure("retryable", "network")));
    req.end(input.body);
  });
}

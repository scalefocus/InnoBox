// Shared HTTP plumbing of the agent-access routes (INNOBOX_SPEC.md §25.2, §25.10, §25.11): the 503
// every route answers while agent access is off, the per-IP limits, OAuth-style error bodies, the
// 1 MB body read (JSON or form), and the system-log rows the routes write themselves — tool
// refusals with the tool name and the person, and the two carve-outs. Never logs a token, code,
// verifier or Authorization header.
import { errorCodeForStatus, sanitizeSystemMessage } from "@innobox/shared";
import { recordSystemEvent } from "@/app/api/admin/system-log/store";
import { clientIpFromForwardedFor, parseTrustProxy, rateLimitIpKey } from "@/lib/client-ip";
import { pool } from "@/lib/db";
import { JSON_BODY_MAX_BYTES, readBytesLimited } from "@/lib/http";
import { takeToken, type RateLimitBucket } from "@/lib/rate-limit";
import { getMcpSettings } from "./store";
import type { McpSettings } from "@innobox/shared";

const TRUST = parseTrustProxy(process.env.TRUST_PROXY);

/** Responses here are never cached (tokens and per-person data). */
export const NO_STORE = { "cache-control": "no-store" } as const;

/** The settings, or the §25.10 "off means dormant" 503 every /mcp, /oauth/* and
 *  /.well-known/oauth-* request answers while agent access is switched off. */
export async function settingsOr503(): Promise<{ ok: true; settings: McpSettings } | { ok: false; response: Response }> {
  const settings = await getMcpSettings(pool);
  if (settings.enabled) return { ok: true, settings };
  return { ok: false, response: Response.json({ error: "Agent access is turned off." }, { status: 503, headers: NO_STORE }) };
}

export function clientIp(req: Request): string | null {
  return clientIpFromForwardedFor(req.headers.get("x-forwarded-for"), TRUST);
}

/** §25.11 per-IP limits (registration; token endpoint and unauthenticated /mcp). An address that
 *  cannot be determined shares one bucket, which can only under-count. */
export function ipLimited(req: Request, bucket: Extract<RateLimitBucket, "mcp-register" | "mcp-ip">): Response | null {
  const decision = takeToken(`ip:${rateLimitIpKey(clientIp(req)) ?? "unknown"}`, bucket);
  if (decision.ok) return null;
  return Response.json(
    { error: "too_many_requests", error_description: "Too many requests — try again shortly." },
    { status: 429, headers: { ...NO_STORE, "Retry-After": String(decision.retryAfterSeconds) } },
  );
}

/** An RFC 6749 §5.2-style error body. */
export function oauthError(status: number, error: string, description?: string): Response {
  return Response.json(description ? { error, error_description: description } : { error }, { status, headers: NO_STORE });
}

/** Reads a JSON or form-encoded body (the token and revocation endpoints take forms, RFC 6749),
 *  capped at the §2.4 1 MB. Null on 413 (returned in `response`) or an unreadable body. */
export async function readParams(req: Request): Promise<{ ok: true; params: Record<string, unknown> } | { ok: false; response: Response }> {
  const bytes = await readBytesLimited(req, JSON_BODY_MAX_BYTES);
  if (!bytes.ok) return bytes;
  const text = new TextDecoder().decode(bytes.value);
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type === "application/json") {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, params: parsed as Record<string, unknown> };
    } catch {
      /* fall through */
    }
    return { ok: false, response: oauthError(400, "invalid_request", "the body must be a JSON object") };
  }
  if (type === "application/x-www-form-urlencoded") {
    const form = new URLSearchParams(text);
    for (const key of new Set(form.keys())) {
      if (form.getAll(key).length > 1) return { ok: false, response: oauthError(400, "invalid_request", `"${key}" is given more than once`) };
    }
    return { ok: true, params: Object.fromEntries(form) };
  }
  return { ok: false, response: oauthError(415, "invalid_request", "the body must be application/x-www-form-urlencoded or application/json") };
}

/**
 * A §14.7 system-log row written by the agent-access routes themselves (they are not wrapped by
 * withSystemLog: /mcp answers tool refusals inside a 200, and the token endpoint's carve-outs are
 * not error statuses of their own). Fire-and-forget — logging never fails the request.
 */
export function recordMcpEvent(event: { status: number; route: string; message: string; errorCode?: string | null; userId?: string | null; method?: string }): void {
  void (async () => {
    let actorName: string | null = null;
    let actorEmail: string | null = null;
    if (event.userId) {
      const { rows } = await pool.query<{ display_name: string | null; email: string | null }>(`select display_name, email from users where id = $1`, [event.userId]);
      actorName = rows[0]?.display_name ?? null;
      actorEmail = rows[0]?.email ?? null;
    }
    await recordSystemEvent(pool, {
      status: event.status,
      method: event.method ?? "POST",
      route: event.route,
      path: event.route,
      userId: event.userId ?? null,
      actorName,
      actorEmail,
      errorCode: event.errorCode ?? errorCodeForStatus(event.status),
      message: sanitizeSystemMessage(event.message),
      source: "web",
    });
  })().catch(() => {});
}

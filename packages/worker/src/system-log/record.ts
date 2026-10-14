// The worker's half of the §14.7 system log (INNOBOX_SPEC.md): the SCIM 401/403 carve-out — a
// wrong provisioning token or SCIM URL is the first symptom of an Entra misconfiguration and
// worth surfacing — plus the 90-day retention trim. Fire-and-forget like the web capture: a
// logging failure never touches the SCIM response. A 401 row says WHY (a reason code, the token
// fingerprints, a whitespace flag) and from WHERE (the real client IP) — never the header or the
// token itself (§14.7 *SCIM rejection detail*).
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Pool } from "pg";
import {
  SCIM_REJECTION_ERROR_CODES,
  SYSTEM_LOG_RETENTION_DAYS,
  pathWithoutQuery,
  sanitizeSystemMessage,
  type SystemEventInput,
} from "@innobox/shared";
import { SCIM_REJECTION_LOCAL, type ScimRejection } from "../scim/router.js";

export const SCIM_ROUTE_TEMPLATE = "/scim/v2/*";

/** The statuses the SCIM observer records — ONLY the auth carve-out (never 404/409/429 here). */
export function scimStatusRecorded(status: number): boolean {
  return status === 401 || status === 403;
}

export async function recordWorkerEvent(pool: Pool, input: SystemEventInput): Promise<void> {
  await pool.query(
    `insert into system_events (status, method, route, path, error_code, message, request_id, duration_ms, source, client_ip)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'worker', $9)`,
    [
      input.status,
      input.method.toUpperCase().slice(0, 16),
      input.route.slice(0, 512),
      input.path.slice(0, 2048),
      input.errorCode ?? null,
      sanitizeSystemMessage(input.message),
      input.requestId ? input.requestId.slice(0, 128) : null,
      input.durationMs == null ? null : Math.max(0, Math.round(input.durationMs)),
      input.clientIp ? input.clientIp.slice(0, 64) : null,
    ],
  );
}

/** The row's error code and one-line message for a rejected SCIM call. Every 401 names the
 *  configured token's fingerprint; a mismatch also names the sent one's. A 401 without a verdict
 *  (none is expected — only the bearer check answers 401) keeps the pre-reason wording. */
export function scimRejectionRow(status: number, rejection: ScimRejection | undefined): { errorCode: string; message: string } {
  if (status === 403) return { errorCode: SCIM_REJECTION_ERROR_CODES.forbidden, message: "SCIM request forbidden" };
  if (!rejection) return { errorCode: "scim_unauthorized", message: "SCIM request rejected: missing or invalid bearer token" };
  const errorCode = SCIM_REJECTION_ERROR_CODES[rejection.reason];
  switch (rejection.reason) {
    case "no_token":
      return { errorCode, message: `SCIM request rejected: no token sent (configured ${rejection.configuredFingerprint})` };
    case "not_bearer":
      return { errorCode, message: `SCIM request rejected: not a bearer token (configured ${rejection.configuredFingerprint})` };
    case "token_mismatch": {
      const ws = rejection.sentHasWhitespace ? "; sent token contains whitespace" : "";
      return {
        errorCode,
        message: `SCIM request rejected: token mismatch (sent ${rejection.sentFingerprint}, configured ${rejection.configuredFingerprint}${ws})`,
      };
    }
  }
}

/** Express middleware mounted ahead of the SCIM router: observes the finished response and
 *  records a 401/403 with the bearer check's verdict and the client IP (`req.ip`, the address
 *  `trust proxy` selects — the same key the SCIM rate limiter uses). No user (the caller is
 *  Entra's provisioning service, not a person). */
export function createScimEventRecorder(pool: Pool, record: (pool: Pool, e: SystemEventInput) => Promise<void> = recordWorkerEvent): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = Date.now();
    res.on("finish", () => {
      const status = res.statusCode;
      if (!scimStatusRecorded(status)) return;
      const { errorCode, message } = scimRejectionRow(status, res.locals[SCIM_REJECTION_LOCAL] as ScimRejection | undefined);
      void record(pool, {
        status,
        method: req.method,
        route: SCIM_ROUTE_TEMPLATE,
        path: pathWithoutQuery(req.originalUrl || req.url),
        errorCode,
        message,
        requestId: typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : null,
        durationMs: Date.now() - startedAt,
        source: "worker",
        clientIp: req.ip ?? req.socket.remoteAddress ?? null,
      }).catch(() => {
        /* telemetry never fails the request */
      });
    });
    next();
  };
}

/** The retention trim (hourly, leader-only): rows older than the retention window are deleted. */
export async function trimSystemEvents(pool: Pool, retentionDays: number = SYSTEM_LOG_RETENTION_DAYS): Promise<number> {
  const { rowCount } = await pool.query(`delete from system_events where created_at < now() - make_interval(days => $1::int)`, [retentionDays]);
  return rowCount ?? 0;
}

// The worker's half of the §14.7 system log (INNOBOX_SPEC.md): the SCIM 401/403 carve-out — a
// wrong provisioning token or SCIM URL is the first symptom of an Entra misconfiguration and
// worth surfacing — plus the 90-day retention trim. Fire-and-forget like the web capture: a
// logging failure never touches the SCIM response.
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Pool } from "pg";
import { SYSTEM_LOG_RETENTION_DAYS, pathWithoutQuery, sanitizeSystemMessage, type SystemEventInput } from "@innobox/shared";

export const SCIM_ROUTE_TEMPLATE = "/scim/v2/*";

/** The statuses the SCIM observer records — ONLY the auth carve-out (never 404/409/429 here). */
export function scimStatusRecorded(status: number): boolean {
  return status === 401 || status === 403;
}

export async function recordWorkerEvent(pool: Pool, input: SystemEventInput): Promise<void> {
  await pool.query(
    `insert into system_events (status, method, route, path, error_code, message, request_id, duration_ms, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'worker')`,
    [
      input.status,
      input.method.toUpperCase().slice(0, 16),
      input.route.slice(0, 512),
      input.path.slice(0, 2048),
      input.errorCode ?? null,
      sanitizeSystemMessage(input.message),
      input.requestId ? input.requestId.slice(0, 128) : null,
      input.durationMs == null ? null : Math.max(0, Math.round(input.durationMs)),
    ],
  );
}

/** Express middleware mounted ahead of the SCIM router: observes the finished response and
 *  records a 401/403. No user (the caller is Entra's provisioning service, not a person). */
export function createScimEventRecorder(pool: Pool, record: (pool: Pool, e: SystemEventInput) => Promise<void> = recordWorkerEvent): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = Date.now();
    res.on("finish", () => {
      const status = res.statusCode;
      if (!scimStatusRecorded(status)) return;
      const message = status === 401 ? "SCIM request rejected: missing or invalid bearer token" : "SCIM request forbidden";
      void record(pool, {
        status,
        method: req.method,
        route: SCIM_ROUTE_TEMPLATE,
        path: pathWithoutQuery(req.originalUrl || req.url),
        errorCode: status === 401 ? "scim_unauthorized" : "scim_forbidden",
        message,
        requestId: typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : null,
        durationMs: Date.now() - startedAt,
        source: "worker",
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

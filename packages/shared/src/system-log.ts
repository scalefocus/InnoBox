// System log rules (INNOBOX_SPEC.md §14.7) — pure and CLIENT-SAFE (also exposed at the
// `@innobox/shared/system-log` subpath for the admin page), shared by the web route wrapper
// (packages/web/src/lib/system-log.ts), the web store, and the worker's SCIM recorder.
// Decides WHAT is recorded and how a message is sanitized; the DB access lives in each tier.

export type SystemEventSource = "web" | "worker";

/** Everything 5xx is recorded; of 4xx only these. 401 (expired-session poll noise) and 404
 *  are never recorded. */
export const SYSTEM_LOG_CLIENT_STATUSES: ReadonlySet<number> = new Set([403, 409, 413, 422, 429]);

export function shouldRecordSystemEvent(status: number): boolean {
  if (status >= 500) return true;
  return SYSTEM_LOG_CLIENT_STATUSES.has(status);
}

export const SYSTEM_LOG_RETENTION_DAYS = 90;
export const SYSTEM_LOG_EXPORT_CAP = 50_000;
export const SYSTEM_LOG_PAGE_SIZE = 100;
export const SYSTEM_LOG_MESSAGE_MAX = 500;

/** One line, no control characters, capped — never a stack trace (the stack goes to stdout). */
export function sanitizeSystemMessage(raw: unknown): string {
  const text = typeof raw === "string" ? raw : raw instanceof Error ? raw.message : raw == null ? "" : String(raw);
  const oneLine = text
    .split(/\r?\n/)[0]!
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  return oneLine.length > SYSTEM_LOG_MESSAGE_MAX ? `${oneLine.slice(0, SYSTEM_LOG_MESSAGE_MAX - 1)}…` : oneLine;
}

/** The status chips on the page: 409 and the worker's 401 carve-out have no chip of their own
 *  and appear under All. */
export const SYSTEM_LOG_STATUS_FILTERS = ["all", "5xx", "403", "413", "422", "429"] as const;
export type SystemLogStatusFilter = (typeof SYSTEM_LOG_STATUS_FILTERS)[number];

export function parseSystemLogStatusFilter(raw: string | null | undefined): SystemLogStatusFilter {
  return (SYSTEM_LOG_STATUS_FILTERS as readonly string[]).includes(raw ?? "") ? (raw as SystemLogStatusFilter) : "all";
}

/** A short machine token for the row's `error_code` when the handler gave none. */
export function errorCodeForStatus(status: number): string {
  switch (status) {
    case 403:
      return "forbidden";
    case 409:
      return "conflict";
    case 413:
      return "payload_too_large";
    case 422:
      return "unprocessable";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "internal_error" : `http_${status}`;
  }
}

export interface SystemEventInput {
  status: number;
  method: string;
  route: string;
  path: string;
  userId?: string | null;
  actorName?: string | null;
  actorEmail?: string | null;
  errorCode?: string | null;
  message: string;
  requestId?: string | null;
  durationMs?: number | null;
  source: SystemEventSource;
}

/** Strips the query string (and fragment) — never stored (§14.7 privacy). */
export function pathWithoutQuery(url: string): string {
  const q = url.indexOf("?");
  const h = url.indexOf("#");
  const cut = Math.min(q === -1 ? url.length : q, h === -1 ? url.length : h);
  return url.slice(0, cut);
}

export interface PathEntity {
  kind: "challenge" | "solution";
  number: number;
}

/**
 * When a route template names a challenge or solution by number, extract that number from the
 * concrete path so the recorder can ask whether the target is anonymous (§9 — the §14.5 masking
 * rule). Returns null for templates with no such segment. The nested
 * `/api/challenges/[number]/solutions` still names the CHALLENGE.
 */
export function entityInPath(template: string, pathname: string): PathEntity | null {
  const t = template.split("/").filter(Boolean);
  const p = pathname.split("/").filter(Boolean);
  const idx = t.indexOf("[number]");
  if (idx === -1 || t.length !== p.length) return null;
  const head = t[idx - 1];
  const kind = head === "challenges" ? "challenge" : head === "solutions" ? "solution" : null;
  if (!kind) return null;
  const n = Number(/^(?:CH-|SOL-)?(\d+)$/i.exec(p[idx] ?? "")?.[1]);
  return Number.isInteger(n) && n > 0 ? { kind, number: n } : null;
}

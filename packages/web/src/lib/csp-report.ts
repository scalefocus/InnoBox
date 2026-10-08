// The CSP violation report sink (INNOBOX_SPEC.md §2.4, `POST /api/csp-report`): the one public,
// unauthenticated API route. It NEVER stores a report — no body, URL, blocked-uri, sample or user
// agent is persisted or logged (a report can carry fragments of page content and URLs). Its only
// effect is the in-process Prometheus counter innobox_csp_violations_total{directive} on the web
// /metrics, with `directive` mapped onto a fixed allowlist so an unauthenticated caller can never
// mint new label values. It is not system-logged (§14.7) and not audited, and the handler never
// throws: every failure resolves to one of its fixed statuses.
import { readBytesLimited } from "./http";
import { takeToken } from "./rate-limit";

/** §2.4: the report sink's body cap (not the 1 MB JSON limit). */
export const CSP_REPORT_MAX_BYTES = 64 * 1024;

/** §2.4: the directive label allowlist. Anything else is `other`. */
export const CSP_DIRECTIVE_LABELS: ReadonlySet<string> = new Set([
  "default-src",
  "script-src",
  "script-src-elem",
  "script-src-attr",
  "style-src",
  "style-src-elem",
  "style-src-attr",
  "img-src",
  "font-src",
  "connect-src",
  "media-src",
  "object-src",
  "frame-src",
  "child-src",
  "worker-src",
  "manifest-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
]);

/** A reported directive → its counter label: lower-cased, allowlisted, else `other`. */
export function directiveLabel(raw: unknown): string {
  if (typeof raw !== "string") return "other";
  const v = raw.trim().toLowerCase();
  return CSP_DIRECTIVE_LABELS.has(v) ? v : "other";
}

const LEGACY_TYPE = "application/csp-report";
const REPORTING_API_TYPE = "application/reports+json";
const JSON_TYPE = "application/json";

/** The media type (no parameters, lower-cased), or null when absent. */
function mediaType(contentType: string | null): string | null {
  if (!contentType) return null;
  return contentType.split(";")[0]!.trim().toLowerCase();
}

/** True when the sink accepts this Content-Type at all (anything else is a 415). */
export function isAcceptedReportType(contentType: string | null): boolean {
  const t = mediaType(contentType);
  return t === LEGACY_TYPE || t === REPORTING_API_TYPE || t === JSON_TYPE;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The counter labels of every violation in a parsed report body, or null when the body matches
 *  neither shape for its Content-Type:
 *    - application/csp-report — the legacy `report-uri` body `{"csp-report": {…}}`, one violation,
 *      labelled by its `effective-directive`;
 *    - application/reports+json — the Reporting API array; only `type: "csp-violation"` entries
 *      count (others are ignored), each labelled by `body.effectiveDirective`;
 *    - application/json — either shape. */
export function violationLabels(contentType: string | null, body: unknown): string[] | null {
  const t = mediaType(contentType);
  if ((t === LEGACY_TYPE || t === JSON_TYPE) && isPlainObject(body)) {
    const report = body["csp-report"];
    if (!isPlainObject(report)) return null;
    return [directiveLabel(report["effective-directive"])];
  }
  if ((t === REPORTING_API_TYPE || t === JSON_TYPE) && Array.isArray(body)) {
    const labels: string[] = [];
    for (const entry of body) {
      if (!isPlainObject(entry) || entry.type !== "csp-violation") continue;
      const inner = isPlainObject(entry.body) ? entry.body : {};
      labels.push(directiveLabel(inner.effectiveDirective));
    }
    return labels;
  }
  return null;
}

// --- The counter -------------------------------------------------------------------------------
// In-process (resets on restart), like every other web-tier counter. Held on globalThis so the
// report route and the /metrics route see one map even if the bundler gives them separate module
// instances.
const COUNTER_KEY = Symbol.for("innobox.cspViolationsTotal");
type CounterHost = { [COUNTER_KEY]?: Map<string, number> };

function counter(): Map<string, number> {
  const host = globalThis as CounterHost;
  return (host[COUNTER_KEY] ??= new Map<string, number>());
}

/** Count one violation per label. */
export function recordCspViolations(labels: readonly string[]): void {
  const map = counter();
  for (const label of labels) map.set(label, (map.get(label) ?? 0) + 1);
}

/** The counter's current values (label → count), for /metrics. */
export function cspViolationCounts(): Array<{ directive: string; count: number }> {
  return [...counter()].map(([directive, count]) => ({ directive, count })).sort((a, b) => a.directive.localeCompare(b.directive));
}

/** Test hook. */
export function resetCspViolationCounts(): void {
  counter().clear();
}

// --- The handler -------------------------------------------------------------------------------

/** The shared bucket key for callers whose address cannot be determined (can only under-count). */
export const UNKNOWN_CLIENT_KEY = "unknown";

function status(code: number, error: string, headers?: Record<string, string>): Response {
  return Response.json({ error }, { status: code, headers });
}

/** 405 for every method but POST. */
export function methodNotAllowed(): Response {
  return status(405, "method not allowed", { Allow: "POST" });
}

/** POST /api/csp-report. `clientIp` is the TRUST_PROXY-selected address (null when none).
 *  429 per IP (not logged individually) → 415 → 413 (64 KB, before the body is read) → 400 →
 *  204 with an empty body. Never throws. */
export async function handleCspReport(req: Request, clientIp: string | null, now: number = Date.now()): Promise<Response> {
  try {
    const decision = takeToken(clientIp ?? UNKNOWN_CLIENT_KEY, "csp-report", now);
    if (!decision.ok) {
      return status(429, "Too many requests — try again shortly.", { "Retry-After": String(decision.retryAfterSeconds) });
    }
    const contentType = req.headers.get("content-type");
    if (!isAcceptedReportType(contentType)) {
      return status(415, "request body must be a CSP report");
    }
    const bytes = await readBytesLimited(req, CSP_REPORT_MAX_BYTES);
    if (!bytes.ok) return bytes.response;

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes.value));
    } catch {
      return status(400, "request body must be valid JSON");
    }
    const labels = violationLabels(contentType, parsed);
    if (!labels) return status(400, "request body is not a CSP report");
    recordCspViolations(labels);
    return new Response(null, { status: 204 });
  } catch {
    // A body that could not be read (aborted stream, …) — still a fixed status, never a throw.
    return status(400, "request body could not be read");
  }
}

// POST /api/csp-report — the CSP violation report sink (INNOBOX_SPEC.md §2.4). The one public API
// route: on the public-path allowlist (lib/routeAccess.ts) and exempt from the CSRF Origin check
// (lib/csrf.ts). Deliberately NOT wrapped in withSystemLog — an unauthenticated endpoint must not
// be a write path into the system log (§14.7) — and never audited. The logic lives in
// lib/csp-report.ts; every method but POST answers 405.
import { clientIpFromForwardedFor, parseTrustProxy } from "@/lib/client-ip";
import { handleCspReport, methodNotAllowed } from "@/lib/csp-report";

export const dynamic = "force-dynamic";

/** TRUST_PROXY, with the worker's semantics; compose passes the same value to web and worker. */
const TRUST = parseTrustProxy(process.env.TRUST_PROXY);

export function POST(req: Request): Promise<Response> {
  return handleCspReport(req, clientIpFromForwardedFor(req.headers.get("x-forwarded-for"), TRUST));
}

export const GET = methodNotAllowed;
export const HEAD = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;

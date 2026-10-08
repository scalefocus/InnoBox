// Cross-site request forgery guard for the §2.4 web security baseline (INNOBOX_SPEC.md). Session
// cookies are SameSite=Lax, which stops other sites but not a sibling sub-domain of the same
// registrable domain — so every state-changing API request must carry an `Origin` equal to the
// deployment's canonical origin. Auth.js routes (/api/auth/*) are exempt: they carry their own
// CSRF token, and so is the public CSP report sink (/api/csp-report, exact path). Pure (its one
// import is the pure security-headers module) so the middleware (edge) and the unit tests share it.
import { CSP_REPORT_PATH } from "./security-headers";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** True for a request the Origin check applies to: a state-changing method under /api/*, outside
 *  the Auth.js routes. Safe methods (GET/HEAD/OPTIONS) never change state and are not checked. */
export function requiresOriginCheck(method: string, pathname: string): boolean {
  if (!STATE_CHANGING_METHODS.has(method.toUpperCase())) return false;
  if (pathname !== "/api" && !pathname.startsWith("/api/")) return false;
  if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) return false;
  // The public CSP report sink (exact path): browsers send reports with no reliable Origin, and
  // a report changes no application state.
  if (pathname === CSP_REPORT_PATH) return false;
  return true;
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

export interface OriginCheckInput {
  method: string;
  pathname: string;
  /** The request's `Origin` header (null when absent). */
  origin: string | null;
  /** The origin the server itself was addressed at (scheme + Host) — used only in dev. */
  requestOrigin: string;
  env: { PUBLIC_BASE_URL?: string; NEXTAUTH_URL?: string };
  dev: boolean;
}

/** The origins a state-changing request may come from: the origin of PUBLIC_BASE_URL (falling
 *  back to NEXTAUTH_URL). Only in local dev, and only when neither is configured, the server's own
 *  origin stands in. A production build with neither set accepts nothing (fails closed). */
export function allowedOrigins(input: Pick<OriginCheckInput, "requestOrigin" | "env" | "dev">): string[] {
  const configured = originOf(input.env.PUBLIC_BASE_URL?.trim() || input.env.NEXTAUTH_URL?.trim() || undefined);
  if (configured) return [configured];
  if (input.dev) {
    const own = originOf(input.requestOrigin);
    return own ? [own] : [];
  }
  return [];
}

/** True when the request may proceed: it is not subject to the check, or its `Origin` matches. */
export function isOriginAllowed(input: OriginCheckInput): boolean {
  if (!requiresOriginCheck(input.method, input.pathname)) return true;
  if (!input.origin) return false;
  const presented = originOf(input.origin.trim());
  if (!presented) return false;
  return allowedOrigins(input).includes(presented);
}

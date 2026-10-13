// Route-access policy, shared by middleware.ts (INNOBOX_SPEC.md §2.1 invariant 2,
// ENTRA_AUTH_SPEC.md §5). Kept dependency-free (no next / next-auth imports) so it is unit-testable
// in isolation and can't drift from the middleware. isPublicPath() is the authoritative gate:
// everything it does NOT mark public requires a valid session.
//
// Public paths: "/" — the Home landing, which doubles as the sign-in surface and, while
// unauthenticated, renders only a static welcome + the sign-in control (no protected data, §13.2);
// the health probes; token-guarded /metrics (§2); the Auth.js endpoints; Next's static assets; and
// the static brand images under /brand/ (the sidebar wordmark, which shows on the signed-out
// landing too — a brand asset like icon.svg/favicon, not protected data).
// NOTE: /whats-new is deliberately NOT public — it stays behind sign-in like every other route
// (invariant 2: all access is auth-required).
// The CSP report sink /api/csp-report (§2.4) is a public API route: browsers send violation
// reports without a session. Exact path only.
// The §24 public submission form — /submit, /submit/confirm and its four /api/public/* routes —
// is the other unauthenticated surface (invariant 2). Exact paths only; while the feature is off
// they answer 404 themselves (§24.2), which this edge-safe layer cannot know.
import { isPublicFormPath, isPublicIntakeApiPath } from "./public-intake-paths";

const PUBLIC_EXACT = new Set(["/", "/healthz", "/readyz", "/metrics", "/icon.svg", "/favicon.ico", "/api/csp-report"]);

// §25.2 agent access: these routes authenticate themselves — the metadata documents, registration,
// token and revocation take no credential and read no application data; /mcp takes a bearer token
// ONLY (a session cookie is never consulted there). /oauth/authorize and /oauth/consent are NOT
// here: they need a session, so a signed-out visitor goes through sign-in and back. Exact paths.
export const AGENT_ACCESS_PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/register",
  "/oauth/token",
  "/oauth/revoke",
  "/mcp",
]);

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  if (AGENT_ACCESS_PUBLIC_PATHS.has(pathname)) return true;
  if (isPublicFormPath(pathname) || isPublicIntakeApiPath(pathname)) return true;
  if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) return true;
  if (pathname.startsWith("/_next/")) return true;
  if (pathname.startsWith("/brand/")) return true;
  return false;
}

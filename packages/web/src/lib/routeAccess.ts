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
// The CSP report sink /api/csp-report (§2.4) is the one public API route: browsers send violation
// reports without a session. Exact path only.
const PUBLIC_EXACT = new Set(["/", "/healthz", "/readyz", "/metrics", "/icon.svg", "/favicon.ico", "/api/csp-report"]);

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) return true;
  if (pathname.startsWith("/_next/")) return true;
  if (pathname.startsWith("/brand/")) return true;
  return false;
}

// First-sign-in onboarding redirect policy (INNOBOX_SPEC.md §13.7). Kept dependency-free (no
// next / next-auth / pg imports) so it is unit-testable in isolation and shared by the server-side
// gate (the root layout, which redirects BEFORE the requested page renders) and the client shell
// (which covers in-app navigations, where the root layout does not re-render).
//
// While the signed-in user's `quick_start_seen_at` is null, every authenticated page route goes to
// /quick-start first — taking priority over a deep-link `callbackUrl`, which is simply the route
// the sign-in returns to and so is redirected like any other. Never redirected: /quick-start itself
// (manual re-access via the account menu is an ordinary page visit), API routes, the Auth.js
// endpoints, health/metrics probes, and static assets.

export const QUICK_START_PATH = "/quick-start";

/** Request header the middleware sets (always overwriting any client-supplied value) so the
 *  server-rendered root layout knows which route is being rendered — Next gives layouts no
 *  pathname of their own. */
export const PATHNAME_HEADER = "x-innobox-pathname";

const EXEMPT_EXACT = new Set([QUICK_START_PATH, "/healthz", "/readyz", "/metrics", "/icon.svg", "/favicon.ico"]);
const EXEMPT_PREFIXES = [`${QUICK_START_PATH}/`, "/api/", "/_next/", "/brand/"];

/** True for routes the onboarding redirect never touches. */
export function isQuickStartExempt(pathname: string): boolean {
  if (EXEMPT_EXACT.has(pathname)) return true;
  if (pathname === "/api") return true;
  return EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** Whether to send this request to /quick-start before rendering it. `seenAt === undefined` means
 *  "no signed-in, active user" — never redirected (the sign-in shell owns that case). */
export function shouldRedirectToQuickStart(pathname: string | null, seenAt: Date | string | null | undefined): boolean {
  if (seenAt !== null) return false; // seen (a timestamp) or no session (undefined)
  if (!pathname) return false; // unknown route: fail open — the client shell still gates it
  return !isQuickStartExempt(pathname);
}

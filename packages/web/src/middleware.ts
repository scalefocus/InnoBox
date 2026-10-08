// Route-protection gate (ENTRA_AUTH_SPEC.md §5): EVERYTHING requires a session except the auth
// endpoints, health probes, static assets, and the Home landing "/" (the public sign-in surface —
// §13.2). /whats-new stays gated, per invariant 2. The public policy lives in lib/routeAccess.ts.
// This layer only verifies a valid next-auth JWT cookie exists (edge-safe, no DB): the
// users.active check and role resolution happen per-request in lib/auth.ts getSessionUser()
// at the node layer, so a deactivated user is cut off there even with a live cookie.
//
// It is also where the per-request half of the §2.4 web security baseline lives: the CSRF Origin
// check on state-changing API requests (lib/csrf.ts), and — on EVERY response this layer
// produces, whichever branch produced it — the nonce-bearing Content-Security-Policy and HSTS
// (lib/security-headers.ts). The env-independent headers come from next.config.ts.
import { getToken } from "next-auth/jwt";
import { NextResponse, type NextRequest } from "next/server";
import { isOriginAllowed } from "./lib/csrf";
import { PRESENCE_METHOD_HEADER, PRESENCE_PATH_HEADER } from "./lib/presence-touch";
import { isPublicPath } from "./lib/routeAccess";
import {
  ATTACHMENT_DOWNLOAD_CSP,
  buildContentSecurityPolicy,
  canonicalBaseUrl,
  generateNonce,
  isAttachmentDownload,
  NONCE_HEADER,
  strictTransportSecurity,
} from "./lib/security-headers";

const isDev = (): boolean => process.env.NODE_ENV !== "production";

interface Security {
  nonce: string;
  csp: string;
}

/** Forwards the matched pathname + method to the node layer, which Next otherwise gives
 *  route handlers no access to. getSessionUser() reads these to stamp presence (§14.5);
 *  the allowlist that decides whether anything is recorded lives there, not here — this
 *  layer stays edge-safe and does no DB work. Also forwards the CSP: Next reads the nonce from
 *  the request's Content-Security-Policy header and applies it to its own inline scripts, and
 *  the root layout reads x-nonce for the theme-init script. */
function withRequestContext(req: NextRequest, stamp: boolean, sec: Security): NextResponse {
  const forwarded = new Headers(req.headers);
  if (stamp) {
    // set(), not append(): a client that sends these headers itself has them overwritten,
    // so presence can only ever reflect the route actually served.
    forwarded.set(PRESENCE_PATH_HEADER, req.nextUrl.pathname);
    forwarded.set(PRESENCE_METHOD_HEADER, req.method);
  } else {
    forwarded.delete(PRESENCE_PATH_HEADER);
    forwarded.delete(PRESENCE_METHOD_HEADER);
  }
  // Always overwritten, so a client-supplied x-nonce / CSP can never reach the renderer.
  forwarded.set(NONCE_HEADER, sec.nonce);
  forwarded.set("Content-Security-Policy", sec.csp);
  return NextResponse.next({ request: { headers: forwarded } });
}

async function route(req: NextRequest, sec: Security): Promise<NextResponse> {
  const { pathname, search } = req.nextUrl;

  // §2.4 CSRF: a state-changing /api/* request (outside Auth.js) must come from our own origin.
  // Checked before anything else, so a forged request never reaches a route handler.
  if (
    !isOriginAllowed({
      method: req.method,
      pathname,
      origin: req.headers.get("origin"),
      requestOrigin: req.nextUrl.origin,
      env: { PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL, NEXTAUTH_URL: process.env.NEXTAUTH_URL },
      dev: isDev(),
    })
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (isPublicPath(pathname)) return withRequestContext(req, false, sec);

  const token = await getToken({ req }); // verifies signature + expiry via NEXTAUTH_SECRET
  if (token?.oid) return withRequestContext(req, true, sec);

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  // Unauthenticated page requests go to the Home landing (the sign-in surface), preserving
  // where they were headed so the "Sign in with Entra ID" button can return them there.
  const home = new URL("/", req.nextUrl.origin);
  home.searchParams.set("callbackUrl", pathname + search);
  return NextResponse.redirect(home);
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const nonce = generateNonce();
  const sec: Security = { nonce, csp: buildContentSecurityPolicy({ nonce, dev: isDev() }) };

  const res = await route(req, sec);
  res.headers.set(
    "Content-Security-Policy",
    isAttachmentDownload(req.method, req.nextUrl.pathname) ? ATTACHMENT_DOWNLOAD_CSP : sec.csp,
  );
  const hsts = strictTransportSecurity(canonicalBaseUrl(process.env));
  if (hsts) res.headers.set("Strict-Transport-Security", hsts);
  return res;
}

// Runs on everything except Next's own /_next/* assets (build output, HMR), so the CSP/HSTS above reach every
// page and API response — public ones (/, the Auth.js routes, the probes, /brand) included.
// isPublicPath() stays the authoritative auth gate and waves the public paths straight through.
// The skipped assets still get the static §2.4 headers from next.config.ts.
export const config = {
  matcher: ["/((?!_next/).*)"],
};

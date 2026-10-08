// Route-protection gate (ENTRA_AUTH_SPEC.md §5): EVERYTHING requires a session except the auth
// endpoints, health probes, static assets, and the Home landing "/" (the public sign-in surface —
// §13.2). /whats-new stays gated, per invariant 2. The public policy lives in lib/routeAccess.ts.
// This layer only verifies a valid next-auth JWT cookie exists (edge-safe, no DB): the
// users.active check and role resolution happen per-request in lib/auth.ts getSessionUser()
// at the node layer, so a deactivated user is cut off there even with a live cookie.
import { getToken } from "next-auth/jwt";
import { NextResponse, type NextRequest } from "next/server";
import { PRESENCE_METHOD_HEADER, PRESENCE_PATH_HEADER } from "./lib/presence-touch";
import { isPublicPath } from "./lib/routeAccess";

/** Forwards the matched pathname + method to the node layer, which Next otherwise gives
 *  route handlers no access to. getSessionUser() reads these to stamp presence (§14.5);
 *  the allowlist that decides whether anything is recorded lives there, not here — this
 *  layer stays edge-safe and does no DB work. */
function withRequestContext(req: NextRequest, stamp: boolean): NextResponse {
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
  return NextResponse.next({ request: { headers: forwarded } });
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname, search } = req.nextUrl;
  if (isPublicPath(pathname)) return withRequestContext(req, false);

  const token = await getToken({ req }); // verifies signature + expiry via NEXTAUTH_SECRET
  if (token?.oid) return withRequestContext(req, true);

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  // Unauthenticated page requests go to the Home landing (the sign-in surface), preserving
  // where they were headed so the "Sign in with Entra ID" button can return them there.
  const home = new URL("/", req.nextUrl.origin);
  home.searchParams.set("callbackUrl", pathname + search);
  return NextResponse.redirect(home);
}

// The matcher skips most public paths early; isPublicPath() stays the authoritative gate (it also
// covers "/", which the matcher still runs through — cheap, and the gate lets it straight past).
export const config = {
  matcher: ["/((?!api/auth|_next|brand/|healthz|readyz|metrics|icon.svg|favicon.ico).*)"],
};

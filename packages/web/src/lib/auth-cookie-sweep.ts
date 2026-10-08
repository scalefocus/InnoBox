// Sign-out cookie sweep (INNOBOX_SPEC.md §3 "Sign-out"; ENTRA_AUTH_SPEC.md §5). On a sign-out
// Auth.js has accepted (its own CSRF check passed), the response additionally expires every
// `next-auth.*` cookie — session token and every chunk of it, CSRF token, callback URL, and
// the PKCE / state / nonce cookies of an unfinished sign-in — so a shared machine keeps no
// InnoBox auth state and no orphaned session chunk can be re-assembled with a newer one.
// Non-auth browser state (theme, collapsed cards, view choice) is never touched.
// Pure helpers + one Response mutator; unit-tested in auth-cookie-sweep.test.ts.

const COOKIE_PREFIXES = ["__Secure-", "__Host-"] as const;

/** Strips a `__Secure-` / `__Host-` prefix (at most one; they are mutually exclusive). */
export function stripCookiePrefix(name: string): string {
  for (const p of COOKIE_PREFIXES) if (name.startsWith(p)) return name.slice(p.length);
  return name;
}

export function hasCookiePrefix(name: string): boolean {
  return COOKIE_PREFIXES.some((p) => name.startsWith(p));
}

/** An Auth.js cookie: after stripping the prefix, the name starts with `next-auth.`. */
export function isAuthCookieName(name: string): boolean {
  return stripCookiePrefix(name).startsWith("next-auth.");
}

/** One expiring Set-Cookie value: Max-Age=0, Path=/, no Domain (Auth.js cookies are
 *  host-only), Secure when the name carries a prefix or the public base URL is https. */
export function expiredCookieHeader(name: string, httpsBase: boolean): string {
  const parts = [`${name}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"];
  if (hasCookiePrefix(name) || httpsBase) parts.push("Secure");
  return parts.join("; ");
}

/** The deduplicated, sorted set of auth cookie names to expire. */
export function authCookiesToExpire(names: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const n of names) if (n && isAuthCookieName(n)) out.add(n);
  return [...out].sort();
}

/** True when PUBLIC_BASE_URL is an https URL (falls back to NEXTAUTH_URL, like csrf.ts). */
export function isHttpsBase(env: Record<string, string | undefined> = process.env): boolean {
  const base = env.PUBLIC_BASE_URL || env.NEXTAUTH_URL || "";
  try {
    return new URL(base).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Whether Auth.js accepted the sign-out, judged from where it sends the browser: a rejected
 * request (CSRF token missing or wrong) is redirected to its own `…/signout?csrf=true` page;
 * an accepted one goes to the callback URL. No redirect at all (an error) → not accepted.
 */
export function isAcceptedSignOutTarget(target: string | null | undefined): boolean {
  if (!target) return false;
  let url: URL;
  try {
    url = new URL(target, "http://localhost");
  } catch {
    return false;
  }
  return !(url.pathname.endsWith("/signout") && url.searchParams.get("csrf") === "true");
}

/** Cookie names from a Cookie request header (`a=1; b=2`). */
export function parseCookieNames(cookieHeader: string | null | undefined): string[] {
  if (!cookieHeader) return [];
  return cookieHeader
    .split(";")
    .map((part) => part.split("=")[0]!.trim())
    .filter(Boolean);
}

/** Cookie names a response sets (`Set-Cookie` values). */
function setCookieNames(res: Response): string[] {
  return res.headers.getSetCookie().map((v) => v.split("=")[0]!.trim()).filter(Boolean);
}

/** The redirect target Auth.js chose: `Location`, or — for the client `signOut()` call
 *  (`json: true`) — the `{ url }` JSON body Auth.js returns instead. */
async function signOutTarget(res: Response): Promise<string | null> {
  const location = res.headers.get("Location");
  if (location) return location;
  if (!(res.headers.get("Content-Type") ?? "").includes("application/json")) return null;
  try {
    const body = (await res.clone().json()) as { url?: unknown };
    return typeof body?.url === "string" ? body.url : null;
  } catch {
    return null;
  }
}

/**
 * Appends the sweep to an accepted sign-out response, in place. Covers every auth cookie the
 * request carried (so chunks are read, never guessed) plus any Auth.js re-set in this same
 * response (e.g. a fresh callback-URL cookie) — appended last, so the expiry wins.
 */
export async function applySignOutCookieSweep(
  requestCookieHeader: string | null,
  res: Response,
  env: Record<string, string | undefined> = process.env,
): Promise<Response> {
  if (!isAcceptedSignOutTarget(await signOutTarget(res))) return res;
  const httpsBase = isHttpsBase(env);
  const names = authCookiesToExpire([...parseCookieNames(requestCookieHeader), ...setCookieNames(res)]);
  for (const name of names) res.headers.append("Set-Cookie", expiredCookieHeader(name, httpsBase));
  return res;
}

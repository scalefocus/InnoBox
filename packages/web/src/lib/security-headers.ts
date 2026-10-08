// Response security headers for the §2.4 web security baseline (INNOBOX_SPEC.md). Pure and
// dependency-free so the middleware (edge), next.config.ts, and the unit tests share one source
// of truth for every header value.
//
// The split: the env-independent headers (STATIC_SECURITY_HEADERS) are attached to EVERY
// response by next.config.ts `headers()` — including the static assets the middleware matcher
// skips — while the per-request ones (the nonce-bearing CSP, and HSTS, which depends on the
// runtime PUBLIC_BASE_URL rather than anything known at build time) are set by the middleware.

/** The Entra sign-in host: the OIDC sign-in form posts to Auth.js, which redirects here, and a
 *  CSP `form-action` also governs the redirect that follows a form submission. */
export const OIDC_AUTHORITY_ORIGIN = "https://login.microsoftonline.com";

/** Request header the middleware uses to hand this request's CSP nonce to the root layout. */
export const NONCE_HEADER = "x-nonce";

/** §2.4: HSTS lifetime (one year). No includeSubDomains/preload — the deployment's own call. */
export const HSTS_VALUE = "max-age=31536000";

/** §2.4: the headers that never vary by request or environment. */
export const STATIC_SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

/** The Content-Security-Policy for one response. With a `nonce`, scripts are allowed only by
 *  that nonce (plus whatever those scripts load, via 'strict-dynamic') — there is deliberately no
 *  'unsafe-inline' script source. `dev` adds what `next dev` needs (React's eval-based debugging
 *  and the HMR websocket) and must never be true in a production build. */
export function buildContentSecurityPolicy(opts: { nonce?: string; dev: boolean }): string {
  const scriptSrc = ["'self'"];
  if (opts.nonce) scriptSrc.push(`'nonce-${opts.nonce}'`, "'strict-dynamic'");
  if (opts.dev) scriptSrc.push("'unsafe-eval'");

  const connectSrc = ["'self'"];
  if (opts.dev) connectSrc.push("ws:", "wss:");

  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", scriptSrc],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["font-src", ["'self'"]],
    ["connect-src", connectSrc],
    ["object-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["form-action", ["'self'", OIDC_AUTHORITY_ORIGIN]],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(" ")}`).join("; ");
}

/** §11 download gateway: a served attachment can never run as script or style in our origin. */
export const ATTACHMENT_DOWNLOAD_CSP = "sandbox; default-src 'none'";

/** True for the attachment download gateway (`GET /api/attachments/:id`). The middleware sets
 *  the response CSP after the route runs, so it must choose the download policy itself rather
 *  than rely on the route's own header surviving the merge. */
export function isAttachmentDownload(method: string, pathname: string): boolean {
  return (method === "GET" || method === "HEAD") && /^\/api\/attachments\/[^/]+$/.test(pathname) && pathname !== "/api/attachments/config";
}

/** The deployment's one canonical URL (§2.3): PUBLIC_BASE_URL, falling back to NEXTAUTH_URL. */
export function canonicalBaseUrl(env: { PUBLIC_BASE_URL?: string; NEXTAUTH_URL?: string }): string | undefined {
  const value = env.PUBLIC_BASE_URL?.trim() || env.NEXTAUTH_URL?.trim();
  return value || undefined;
}

/** The HSTS header value when the canonical URL is https, else null (never on plain http). */
export function strictTransportSecurity(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).protocol === "https:" ? HSTS_VALUE : null;
  } catch {
    return null;
  }
}

/** A fresh, unguessable CSP nonce: 128 random bits, base64-encoded (Web Crypto — edge-safe). */
export function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

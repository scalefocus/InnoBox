// The deployment's one canonical URL (INNOBOX_SPEC.md §2.3). Web and worker read PUBLIC_BASE_URL
// through these helpers only — no other variable (NEXTAUTH_URL included) is consulted as a
// fallback, and no deployment-specific host lives in the repository. Dependency-free, so the edge
// middleware can import it through the `@innobox/shared/public-url` subpath.

/** The documented development default, used only outside production. */
export const DEV_PUBLIC_BASE_URL = "http://localhost:3000";

export interface PublicUrlEnv {
  PUBLIC_BASE_URL?: string;
  NODE_ENV?: string;
}

/** PUBLIC_BASE_URL as configured — trimmed, trailing slashes dropped — or undefined when unset
 *  or blank (compose passes an unset variable as ""). No development default: the edge
 *  consumers (CSRF origin check, CSP report endpoint, HSTS) use the request's own origin then. */
export function configuredPublicBaseUrl(env: PublicUrlEnv = process.env): string | undefined {
  const value = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  return value || undefined;
}

/** The canonical base URL with no trailing slash: PUBLIC_BASE_URL, or outside production the
 *  development default. A production process with it unset refuses to start (see
 *  `publicBaseUrlStartupViolation`), so the "" a production env without it yields is reachable
 *  only where that guard does not run (e.g. `next build`). */
export function publicBaseUrl(env: PublicUrlEnv = process.env): string {
  const configured = configuredPublicBaseUrl(env);
  if (configured) return configured;
  return env.NODE_ENV === "production" ? "" : DEV_PUBLIC_BASE_URL;
}

/** The fatal structured log line when a production process has no PUBLIC_BASE_URL (unset or
 *  blank), else null — the web `register` hook and the worker start-up print it and exit 1, so a
 *  missing URL fails the /readyz smoke check instead of shipping empty links. */
export function publicBaseUrlStartupViolation(env: PublicUrlEnv): string | null {
  if (env.NODE_ENV !== "production") return null;
  if (configuredPublicBaseUrl(env)) return null;
  return JSON.stringify({
    level: "fatal",
    msg: "PUBLIC_BASE_URL is not set in a production build — refusing to start. Set it to the deployment's public URL.",
    variable: "PUBLIC_BASE_URL",
  });
}

// Next.js instrumentation hook — register() runs once when the server starts (in the standalone
// production server too; never during `next build`). INNOBOX_SPEC.md §2.3: a production build
// that finds INNOBOX_DEV_AUTH set, CSP_MODE=off / an unrecognised CSP_MODE, or no PUBLIC_BASE_URL
// refuses to start — and so does one with no single Entra tenant (ENTRA_AUTH_SPEC.md §5). Only the Node.js runtime can exit the process; the edge runtime (middleware) has no process.exit and needs no second check.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { devAuthStartupViolation } = await import("./lib/dev-auth-guard");
  const fatal = devAuthStartupViolation({
    NODE_ENV: process.env.NODE_ENV,
    INNOBOX_DEV_AUTH: process.env.INNOBOX_DEV_AUTH,
  });
  if (fatal) {
    console.error(fatal);
    process.exit(1);
  }

  // ENTRA_AUTH_SPEC.md §5 layer 1: sign-in must be pinned to one tenant — an unset, blank or
  // multi-tenant ENTRA_TENANT_ID would let the provider fall back to `common`.
  const { entraTenantStartupViolation } = await import("./lib/entra-tenant");
  const tenantFatal = entraTenantStartupViolation({
    NODE_ENV: process.env.NODE_ENV,
    ENTRA_TENANT_ID: process.env.ENTRA_TENANT_ID,
  });
  if (tenantFatal) {
    console.error(tenantFatal);
    process.exit(1);
  }

  // §2.3/§2.4: CSP_MODE gets the same treatment — off, or an unrecognised value, refuses to
  // start in a production build; outside production an unrecognised value is enforce + a warning.
  const { cspModeStartupCheck } = await import("./lib/csp-mode");
  const csp = cspModeStartupCheck({ NODE_ENV: process.env.NODE_ENV, CSP_MODE: process.env.CSP_MODE });
  if (csp.fatal) {
    console.error(csp.fatal);
    process.exit(1);
  }
  if (csp.warning) console.warn(csp.warning);

  // §2.3: every canonical link derives from PUBLIC_BASE_URL — a production build without it
  // refuses to start instead of shipping empty links.
  const { publicBaseUrlStartupViolation } = await import("@innobox/shared/public-url");
  const baseUrlFatal = publicBaseUrlStartupViolation({ NODE_ENV: process.env.NODE_ENV, PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL });
  if (baseUrlFatal) {
    console.error(baseUrlFatal);
    process.exit(1);
  }
}

// onRequestError (INNOBOX_SPEC.md §14.7 "Capture — net"): records uncaught 500s on
// anything the `withSystemLog` route wrapper does not cover (page renders, server actions).
// Loaded once at boot; best-effort — a failure here is swallowed, never re-thrown into the
// request.
//
// Next compiles this file for BOTH runtimes. The database path (pg, next-auth) exists only in
// Node, so the import sits inside the documented `NEXT_RUNTIME === "nodejs"` block: the edge
// build sees `if (false) { … }` and drops the import entirely instead of failing to resolve
// `crypto`. A plain early return does not get that treatment (register() above can use one only
// because its import is edge-safe).
export async function onRequestError(
  err: unknown,
  request: { path: string; method: string; headers: Record<string, string | string[] | undefined> },
  context: { routerKind: string; routePath: string; routeType: string },
): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { recordUncaughtRequestError } = await import("./lib/system-log");
      await recordUncaughtRequestError(err, request, context);
    } catch {
      /* telemetry must never fail the request */
    }
  }
}

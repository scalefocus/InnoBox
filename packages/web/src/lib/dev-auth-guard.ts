// Dev-auth fail-loud startup check (INNOBOX_SPEC.md §2.3). The structural guard in
// authOptions.ts (the dev Credentials provider is registered only when NODE_ENV is not
// "production") is the actual protection and is unchanged. This check exists so the mistake is
// loud, not silent: a production build that finds INNOBOX_DEV_AUTH set refuses to start, and a
// bad deploy env fails the /readyz smoke check instead of shipping unnoticed. Pure, so the rule
// is unit-testable apart from the Next.js register() hook (src/instrumentation.ts) that applies it.

export interface DevAuthGuardEnv {
  NODE_ENV?: string;
  INNOBOX_DEV_AUTH?: string;
}

/** The fatal structured log line when a production build sees INNOBOX_DEV_AUTH set (any
 *  non-empty value — an empty string is how an unset compose variable arrives), else null.
 *  Names the variable; its value is irrelevant and is not echoed. */
export function devAuthStartupViolation(env: DevAuthGuardEnv): string | null {
  if (env.NODE_ENV !== "production") return null;
  if (!env.INNOBOX_DEV_AUTH) return null;
  return JSON.stringify({
    level: "fatal",
    msg: "INNOBOX_DEV_AUTH is set in a production build — refusing to start. Remove it from the deployment environment.",
    variable: "INNOBOX_DEV_AUTH",
  });
}

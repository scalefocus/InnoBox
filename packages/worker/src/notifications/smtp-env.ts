// The optional plain-text SMTP fallback transport's configuration (INNOBOX_SPEC.md §12.1, §2.3).
// No deployment-specific default lives in the repository (§2.3), so the sender address must be
// configured: SMTP_USER stands in when SMTP_FROM is unset, and without either the transport
// counts as not configured — Graph e-mail and the in-app inbox are unaffected.
//
// "Unset" includes empty / whitespace-only: docker compose passes `SMTP_FROM: ${SMTP_FROM:-}`, so
// an unset variable in deploy/.env reaches the process as "" — which must fall back too.
import type { SmtpEnv } from "./dispatch.js";

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Builds the SMTP transport env, or null when the transport is not configured. `warn` is called
 *  (once per call) when SMTP_HOST is set but no sender address can be derived. */
export function buildSmtpEnv(env: Record<string, string | undefined>, warn: (msg: string) => void = () => {}): SmtpEnv | null {
  const host = nonEmpty(env.SMTP_HOST);
  if (!host) return null;
  const user = nonEmpty(env.SMTP_USER);
  const from = nonEmpty(env.SMTP_FROM) ?? user;
  if (!from) {
    warn("SMTP_HOST is set but neither SMTP_FROM nor SMTP_USER is — SMTP fallback disabled");
    return null;
  }
  const port = Number(nonEmpty(env.SMTP_PORT) ?? 587);
  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 587,
    secure: env.SMTP_SECURE === "1",
    user,
    password: env.SMTP_PASSWORD || undefined,
    from,
  };
}

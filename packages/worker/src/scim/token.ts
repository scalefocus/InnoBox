// SCIM bearer-token startup check (ENTRA_AUTH_SPEC.md §3 *Auth*). SCIM_BEARER_TOKEN is the only
// secret guarding a public endpoint that can create users and change group membership, so a
// short or empty value is a configuration error: the worker refuses to start. So is a value that
// begins or ends with whitespace — HTTP strips whitespace around a header value, so no request
// could ever match it. Pure, so the rules are unit-testable apart from the bootstrap in index.ts.
import { createHash } from "node:crypto";

/** Minimum accepted length of SCIM_BEARER_TOKEN (`openssl rand -base64 48` yields 64). */
export const SCIM_TOKEN_MIN_LENGTH = 32;

export type ScimTokenFailure = "missing" | "too_short" | "edge_whitespace";

export type ScimTokenCheck =
  | { ok: true; token: string }
  | { ok: false; reason: ScimTokenFailure };

/** Validate the configured SCIM bearer token. The result never echoes the value back, so a
 *  caller logging the failure cannot leak it. */
export function checkScimBearerToken(value: string | undefined | null): ScimTokenCheck {
  if (!value) return { ok: false, reason: "missing" };
  if (value.length < SCIM_TOKEN_MIN_LENGTH) return { ok: false, reason: "too_short" };
  // Never trimmed silently: the operator fixes the value, so Entra and the worker agree on it.
  if (/^\s|\s$/.test(value)) return { ok: false, reason: "edge_whitespace" };
  return { ok: true, token: value };
}

const FATAL_MSG: Record<ScimTokenFailure, string> = {
  missing: "SCIM_BEARER_TOKEN is required — refusing to start",
  too_short: `SCIM_BEARER_TOKEN must be at least ${SCIM_TOKEN_MIN_LENGTH} characters — refusing to start`,
  edge_whitespace: "SCIM_BEARER_TOKEN must not begin or end with whitespace (no request could ever match it) — refusing to start",
};

/** The fatal log line for a failed check: names the variable and the rule, never the value. */
export function scimTokenFatalLog(reason: ScimTokenFailure): string {
  return JSON.stringify({ level: "fatal", msg: FATAL_MSG[reason], variable: "SCIM_BEARER_TOKEN", reason });
}

/** The §14.7 token fingerprint: the first 8 lowercase hex characters of the SHA-256 of the
 *  token's UTF-8 bytes, exactly as compared. An operator reproduces it with
 *  `printf %s "<token>" | sha256sum | cut -c1-8`. */
export function scimTokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 8);
}

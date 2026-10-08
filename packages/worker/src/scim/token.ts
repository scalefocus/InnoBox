// SCIM bearer-token startup check (ENTRA_AUTH_SPEC.md §3 *Auth*). SCIM_BEARER_TOKEN is the only
// secret guarding a public endpoint that can create users and change group membership, so a
// short or empty value is a configuration error: the worker refuses to start. Pure, so the
// rule is unit-testable apart from the process bootstrap in index.ts.

/** Minimum accepted length of SCIM_BEARER_TOKEN (`openssl rand -base64 48` yields 64). */
export const SCIM_TOKEN_MIN_LENGTH = 32;

export type ScimTokenCheck =
  | { ok: true; token: string }
  | { ok: false; reason: "missing" | "too_short" };

/** Validate the configured SCIM bearer token. The result never echoes the value back, so a
 *  caller logging the failure cannot leak it. */
export function checkScimBearerToken(value: string | undefined | null): ScimTokenCheck {
  if (!value) return { ok: false, reason: "missing" };
  if (value.length < SCIM_TOKEN_MIN_LENGTH) return { ok: false, reason: "too_short" };
  return { ok: true, token: value };
}

/** The fatal log line for a failed check: names the variable and the rule, never the value. */
export function scimTokenFatalLog(reason: "missing" | "too_short"): string {
  return JSON.stringify({
    level: "fatal",
    msg:
      reason === "missing"
        ? "SCIM_BEARER_TOKEN is required — refusing to start"
        : `SCIM_BEARER_TOKEN must be at least ${SCIM_TOKEN_MIN_LENGTH} characters — refusing to start`,
    variable: "SCIM_BEARER_TOKEN",
    reason,
  });
}

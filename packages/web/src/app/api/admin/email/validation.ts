// Pure validation for the /api/admin/email/callback OAuth redirect (INNOBOX_SPEC.md §12.1).
// Extracted from the route handler so the state/PKCE verification logic — previously only
// reachable by actually driving a browser through the Entra consent flow — has direct,
// fast unit test coverage.
export type CallbackValidation =
  | { ok: true; code: string; verifier: string }
  | { ok: false; errorCode: string };

export function validateCallbackParams(input: {
  code: string | null;
  state: string | null;
  errorParam: string | null;
  expectedState: string | undefined;
  verifier: string | undefined;
}): CallbackValidation {
  if (input.errorParam) return { ok: false, errorCode: input.errorParam };
  if (!input.code || !input.state || !input.expectedState || !input.verifier || input.state !== input.expectedState) {
    return { ok: false, errorCode: "invalid_state" };
  }
  return { ok: true, code: input.code, verifier: input.verifier };
}

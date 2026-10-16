// "Sign out everywhere" (INNOBOX_SPEC.md §3): the pure comparison between a session token's
// issue time and `users.sessions_valid_from`. Kept dependency-free so the unit runner can pin it
// (session-revocation.test.ts); getSessionUser() (lib/auth.ts) is its one production caller.

export interface SessionRevocationInput {
  /** The token's issue time in SECONDS since the epoch (the `issuedAt` claim stamped by the
   *  jwt callback at first mint, lib/authOptions.ts). Undefined for a token minted before the
   *  claim existed — treated as issued at epoch 0, so any stamp at all refuses it. */
  issuedAt: number | null | undefined;
  /** `users.sessions_valid_from` as `pg` returns a timestamptz (a Date), or null = never stamped. */
  sessionsValidFrom: Date | null | undefined;
}

/** True when the session must be treated as no session: the row carries a stamp and the token
 *  was issued strictly before it. A never-stamped row (null) accepts every token. The token's
 *  seconds precision floors its issue time, so a stamp taken in the same second as the mint
 *  refuses the token too — stamping is "everything up to and including now". */
export function isSessionRevoked({ issuedAt, sessionsValidFrom }: SessionRevocationInput): boolean {
  if (!sessionsValidFrom) return false;
  const issuedMs = typeof issuedAt === "number" && Number.isFinite(issuedAt) ? issuedAt * 1000 : 0;
  return issuedMs < sessionsValidFrom.getTime();
}

/** The `issuedAt` claim's value for a token minted now: whole seconds, like the JWT `iat`. */
export function nowInSeconds(now: number = Date.now()): number {
  return Math.floor(now / 1000);
}

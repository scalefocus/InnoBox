// §14.10 identity sync diagnostics (INNOBOX_SPEC.md): the pieces both tiers share — the settings
// key the worker stamps on accepted SCIM requests, its throttle interval, and the pure
// explanation-selection logic the platform-admin card renders. Client-safe (no node imports), also
// exposed at `@innobox/shared/identity-sync`.

/** `platform_settings` key holding the last bearer-accepted SCIM request (ISO UTC string, §5). */
export const SCIM_LAST_REQUEST_AT_KEY = "scim_last_request_at";

/** The worker writes the stamp at most once per this interval, per process (§14.10). */
export const SCIM_LAST_REQUEST_STAMP_INTERVAL_MS = 60_000;

/** At most one fixed explanation, chosen by the counts (§14.10). */
export type IdentitySyncState = "ok" | "nothing_synced" | "users_no_groups";

export interface IdentitySyncCounts {
  /** Provisioned users (scim_synced, not scrubbed) — active + deactivated. */
  users: number;
  /** Provisioned groups (groups.scim_synced). */
  groups: number;
}

/** Picks the explanation: nothing at all → nothing_synced; users but no groups → users_no_groups;
 *  anything else (including groups without users) → ok. A stale last-request time is deliberately
 *  NOT an input — a quiet tenant can legitimately go hours without a SCIM call. */
export function identitySyncState(counts: IdentitySyncCounts): IdentitySyncState {
  const users = Math.max(0, counts.users);
  const groups = Math.max(0, counts.groups);
  if (users === 0 && groups === 0) return "nothing_synced";
  if (users > 0 && groups === 0) return "users_no_groups";
  return "ok";
}

/** The fixed explanation copy per state (null = none shown). User-facing — no spec references. */
export const IDENTITY_SYNC_EXPLANATIONS: Record<IdentitySyncState, string | null> = {
  nothing_synced:
    "Nothing has been provisioned yet. In the enterprise application's Provisioning settings, check that the Tenant URL is this site's address followed by /scim/v2, that the Secret Token matches the deployment's SCIM token, and that provisioning has been started (status On). Then use Provision on demand for one user to test.",
  users_no_groups:
    "Users are arriving but groups are not, and roles come only from groups. In the enterprise application, assign the groups themselves (not only their members) under Users and groups, keep the scope at 'Sync only assigned users and groups', and make sure the group mapping is enabled. The next provisioning cycle brings them in.",
  ok: null,
};

/** The fixed hint beside every mapped group that never arrived. */
export const UNARRIVED_GROUP_HINT = "Assign this group to the enterprise application, or remove the mapping.";

/** The collapsed card header chip: "N users · M groups", or "Not synced" when both are zero. */
export function identitySyncSummaryLabel(counts: IdentitySyncCounts): string {
  const { users, groups } = counts;
  if (users === 0 && groups === 0) return "Not synced";
  return `${users} ${users === 1 ? "user" : "users"} · ${groups} ${groups === 1 ? "group" : "groups"}`;
}

/** Why the newest rejected SCIM call was turned away (§14.7 reason codes, §14.10 card). */
export type ScimRejectionReason = "no_token" | "not_bearer" | "token_mismatch" | "forbidden";

/** The system-log `error_code` the worker writes for each reason. Rows written before reasons
 *  were recorded carry `scim_unauthorized`, which maps to no reason. */
export const SCIM_REJECTION_ERROR_CODES: Record<ScimRejectionReason, string> = {
  no_token: "scim_no_token",
  not_bearer: "scim_not_bearer",
  token_mismatch: "scim_token_mismatch",
  forbidden: "scim_forbidden",
};

export function scimRejectionReasonFromErrorCode(code: string | null | undefined): ScimRejectionReason | null {
  for (const [reason, value] of Object.entries(SCIM_REJECTION_ERROR_CODES)) {
    if (value === code) return reason as ScimRejectionReason;
  }
  return null;
}

/** The reason as the card shows it beside the rejection time. */
export const SCIM_REJECTION_LABELS: Record<ScimRejectionReason, string> = {
  no_token: "No token sent",
  not_bearer: "Not a bearer token",
  token_mismatch: "Wrong token",
  forbidden: "Forbidden",
};

/** The fixed hint under the line per reason (null = none). User-facing — no spec references. */
export const SCIM_REJECTION_HINTS: Record<ScimRejectionReason, string | null> = {
  no_token:
    "The last rejected call carried no token. If it came from Entra, check that the proxy in front of this site passes the Authorization header through. The System log shows the caller's address.",
  not_bearer:
    "The last rejected call used a different kind of credential. In the enterprise application's Provisioning settings, put the SCIM token in Secret Token.",
  token_mismatch:
    "The token sent doesn't match this deployment's SCIM token. The System log shows both fingerprints. Paste the deployment's token into Secret Token, or, if the token was just changed, check the new value is the one the running site was started with.",
  forbidden: null,
};

/** The hint shows only while the newest rejection is later than the last accepted request (or
 *  nothing was ever accepted): once an accepted request is newer, provisioning has got through. */
export function scimRejectionHint(input: {
  reason: ScimRejectionReason | null;
  lastRejectedAt: string | null;
  lastAcceptedAt: string | null;
}): string | null {
  const { reason, lastRejectedAt, lastAcceptedAt } = input;
  if (!reason || !lastRejectedAt) return null;
  if (lastAcceptedAt && Date.parse(lastAcceptedAt) >= Date.parse(lastRejectedAt)) return null;
  return SCIM_REJECTION_HINTS[reason];
}

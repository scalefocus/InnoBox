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

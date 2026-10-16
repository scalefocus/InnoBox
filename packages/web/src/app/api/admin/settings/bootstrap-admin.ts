// §2.3 *INNOBOX_BOOTSTRAP_ADMIN_GROUP is a standing grant* (INNOBOX_SPEC.md): while the variable is
// set, its members are platform admins regardless of role_mappings (ENTRA_AUTH_SPEC.md §3). So that
// it is not forgotten after first run, the Administration page shows a platform-admin-only notice
// whenever the variable is set AND at least one platform_admin role mapping already exists — the
// moment the grant has become redundant. Pure: the env value and the mapping count come from the
// route, which reads them from process.env and the store.

/** The notice's copy, verbatim from the spec (user-facing — no spec section reference). */
export const BOOTSTRAP_ADMIN_NOTICE =
  "Bootstrap admin group is still configured; remove INNOBOX_BOOTSTRAP_ADMIN_GROUP once a role mapping grants platform admin.";

/** `bootstrapAdminGroupActive`: the variable is set to a non-blank value and a platform_admin role
 *  mapping exists. A blank value counts as unset — lib/auth.ts never queries the group for it either. */
export function bootstrapAdminGroupActive(bootstrapGroupEnv: string | undefined | null, platformAdminMappings: number): boolean {
  const configured = typeof bootstrapGroupEnv === "string" && bootstrapGroupEnv.trim() !== "";
  return configured && platformAdminMappings > 0;
}

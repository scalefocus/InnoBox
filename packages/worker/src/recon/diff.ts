// Pure drift computations for the Entra reconciliation pass (ENTRA_AUTH_SPEC.md §5).
// No I/O: reconcile.ts feeds these the local row and the Graph snapshot, unit tests
// exercise every heal path hermetically. Reconciliation is TENANT-based, not
// app-assignment-based — sign-in is open to the tenant, so a JIT user who was never
// assigned to the provisioning app is deactivated only when the tenant account is
// gone or disabled, never for mere unassignment.

/** The Graph view of a user, as returned by recon/graph.ts getUser() (404 → exists:false). */
export type GraphUser =
  | { exists: false }
  | {
      exists: true;
      accountEnabled: boolean;
      displayName: string;
      userPrincipalName: string;
      mail: string | null;
      department: string | null;
      jobTitle: string | null;
      officeLocation: string | null;
    };

/**
 * Normalizes a directory-profile attribute (department, job title, office location) from Graph:
 * absent, empty, or whitespace-only → NULL; otherwise the trimmed value. Entra can hand back ""
 * for a cleared attribute, and §3 requires that clearing it upstream clears it here — a stored
 * empty string would render as a blank label instead of no label.
 */
export function directoryAttr(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** The local `users` columns reconciliation may refresh (spec §4 / §5 pass step 1). */
export interface LocalUserAttrs {
  userName: string;
  displayName: string;
  email: string | null;
  department: string | null;
  jobTitle: string | null;
  officeLocation: string | null;
}

/** Column-keyed patch of ONLY the drifted fields — reconcile.ts builds its UPDATE from it. */
export interface UserFieldPatch {
  user_name?: string;
  display_name?: string;
  email?: string | null;
  department?: string | null;
  job_title?: string | null;
  office_location?: string | null;
}

export type UserHeal =
  | { action: "deactivate" }
  | { action: "refresh"; patch: UserFieldPatch }
  | { action: "none" };

/**
 * Decide the heal for one active local user against its Graph snapshot:
 * missing-in-tenant or disabled → deactivate; attribute drift → minimal refresh patch;
 * otherwise none. Photo drift is handled separately (it needs the ETag round-trip).
 */
export function computeUserHeal(local: LocalUserAttrs, graph: GraphUser): UserHeal {
  if (!graph.exists || !graph.accountEnabled) return { action: "deactivate" };

  const patch: UserFieldPatch = {};
  // UPN casing is not stable across Entra surfaces and users.user_name is compared
  // case-insensitively (unique on lower(user_name), spec §4) — only a real rename is
  // drift; a pure case change would just churn every pass.
  if (graph.userPrincipalName.toLowerCase() !== local.userName.toLowerCase()) {
    patch.user_name = graph.userPrincipalName;
  }
  if (graph.displayName !== local.displayName) patch.display_name = graph.displayName;
  if (graph.mail !== local.email) patch.email = graph.mail;
  // Directory profile (§13.8): refreshed unconditionally like every other attribute here — a
  // Graph value that is absent or empty writes NULL, so clearing it upstream clears it locally.
  // Normalized here too (graph.ts already does), so an empty string can never be written.
  const department = directoryAttr(graph.department);
  const jobTitle = directoryAttr(graph.jobTitle);
  const officeLocation = directoryAttr(graph.officeLocation);
  if (department !== local.department) patch.department = department;
  if (jobTitle !== local.jobTitle) patch.job_title = jobTitle;
  if (officeLocation !== local.officeLocation) patch.office_location = officeLocation;

  return Object.keys(patch).length > 0 ? { action: "refresh", patch } : { action: "none" };
}

/**
 * Set difference for group membership healing: `add` = in Graph but not local,
 * `remove` = local but not in Graph. Duplicates are ignored; input order is preserved.
 * Works on whatever id domain the caller diffs in (reconcile.ts uses Entra oids).
 */
export function computeMembershipDiff(
  localUserIds: readonly string[],
  graphUserIds: readonly string[],
): { add: string[]; remove: string[] } {
  const local = new Set(localUserIds);
  const graph = new Set(graphUserIds);
  const add: string[] = [];
  for (const id of graph) if (!local.has(id)) add.push(id);
  const remove: string[] = [];
  for (const id of local) if (!graph.has(id)) remove.push(id);
  return { add, remove };
}

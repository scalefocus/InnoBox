// Layer-3 RBAC resolution (INNOBOX_SPEC.md §4, ENTRA_AUTH_SPEC.md §5): roles come from
// SCIM-synced group membership joined through role_mappings — NEVER from token claims
// (invariant 1). This module is the pure half: callers run the indexed join (plus the
// bootstrap-group check) and hand the resulting grants to buildRoleSet. Inactive users
// must never reach here — getSessionUser() rejects them upstream, so zero-role semantics
// for leavers are enforced before resolution.

export type Role = "platform_admin" | "namespace_admin" | "committee" | "member";

export interface RoleGrant {
  role: Role;
  /** Namespace scope; null only for platform_admin (mirrors the role_mappings CHECK). */
  namespaceId: string | null;
}

export interface RoleSet {
  grants: readonly RoleGrant[];
  isPlatformAdmin: boolean;
  /** True for platform admins in every namespace. */
  isNamespaceAdmin(namespaceId: string): boolean;
  /** Strict: only an explicit committee grant qualifies — admins get override powers
   *  elsewhere, not the committee's enforced state machine (§7.2). */
  isCommittee(namespaceId: string): boolean;
  /** Any grant in the namespace, or platform admin; always true for the global namespace. */
  isMemberOf(namespaceId: string): boolean;
  /** Namespace ids the user belongs to, always including global. */
  memberNamespaces(): string[];
}

export interface BuildRoleSetOptions {
  /** User is in INNOBOX_BOOTSTRAP_ADMIN_GROUP while that env is set (ENTRA_AUTH_SPEC.md §2). */
  bootstrapPlatformAdmin?: boolean;
  /** id of the built-in 'global' namespace — every active user is an implicit member (§4.1). */
  globalNamespaceId: string;
}

export function buildRoleSet(grants: RoleGrant[], opts: BuildRoleSetOptions): RoleSet {
  const combined: RoleGrant[] = [...grants];
  if (opts.bootstrapPlatformAdmin) combined.push({ role: "platform_admin", namespaceId: null });
  combined.push({ role: "member", namespaceId: opts.globalNamespaceId });

  const seen = new Set<string>();
  const deduped: RoleGrant[] = [];
  for (const g of combined) {
    const key = JSON.stringify([g.role, g.namespaceId]);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ role: g.role, namespaceId: g.namespaceId });
  }

  const isPlatformAdmin = deduped.some((g) => g.role === "platform_admin");

  const rolesByNamespace = new Map<string, Set<Role>>();
  for (const g of deduped) {
    if (g.namespaceId === null) continue;
    let set = rolesByNamespace.get(g.namespaceId);
    if (!set) {
      set = new Set();
      rolesByNamespace.set(g.namespaceId, set);
    }
    set.add(g.role);
  }

  return {
    grants: Object.freeze(deduped),
    isPlatformAdmin,
    isNamespaceAdmin(namespaceId: string): boolean {
      return isPlatformAdmin || rolesByNamespace.get(namespaceId)?.has("namespace_admin") === true;
    },
    isCommittee(namespaceId: string): boolean {
      return rolesByNamespace.get(namespaceId)?.has("committee") === true;
    },
    isMemberOf(namespaceId: string): boolean {
      return (
        isPlatformAdmin ||
        namespaceId === opts.globalNamespaceId ||
        rolesByNamespace.has(namespaceId)
      );
    },
    memberNamespaces(): string[] {
      // The injected implicit grant guarantees global is present exactly once.
      return [...rolesByNamespace.keys()];
    },
  };
}

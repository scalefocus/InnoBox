// Audit browser vocabulary (INNOBOX_SPEC.md §15) — pure and CLIENT-SAFE (also exposed at the
// `@innobox/shared/audit-browser` subpath for the admin page). The category chips group audit
// actions by their dotted prefix; the store turns a category into `action LIKE` predicates.

export const AUDIT_CATEGORIES = ["all", "challenges", "solutions", "comments", "attachments", "identity", "admin"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_CATEGORY_LABEL: Record<AuditCategory, string> = {
  all: "All",
  challenges: "Challenges",
  solutions: "Solutions",
  comments: "Comments",
  attachments: "Attachments",
  identity: "Identity",
  admin: "Admin",
};

/** SQL LIKE patterns per category (`%` is the wildcard). Anything not covered by a chip —
 *  likes, anonymity reveals, probes — still appears under All. */
export const AUDIT_CATEGORY_PATTERNS: Record<Exclude<AuditCategory, "all">, readonly string[]> = {
  challenges: ["challenge.%"],
  solutions: ["solution.%"],
  comments: ["comment.%"],
  attachments: ["attachment.%"],
  identity: ["user.%", "scim.%", "role_mapping.%", "recon.%"],
  admin: ["settings.%", "namespace.%", "impact_area.%", "system_banner.%", "presence.%", "email.%", "audit.%", "%.exported"],
};

export function parseAuditCategory(raw: string | null | undefined): AuditCategory {
  return (AUDIT_CATEGORIES as readonly string[]).includes(raw ?? "") ? (raw as AuditCategory) : "all";
}

/** Pages of 100, infinite scroll (§15). */
export const AUDIT_PAGE_SIZE = 100;
/** The CSV export cap, newest-first (§15). */
export const AUDIT_EXPORT_CAP = 50_000;

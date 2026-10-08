// Pure crumb-list builders for the shared <Breadcrumb> (INNOBOX_SPEC.md §2.2, §14).
// Kept free of React/Next imports so the crumb contract is unit-testable under the
// project's `node --test` runner (mirrors the validation.ts / validation.test.ts split).
export interface Crumb {
  label: string;
  /** Omitted on the trailing (current-page) crumb, which renders as plain text, never a link. */
  href?: string;
}

// The Administration console trail (§14): a link back to the console root, then the
// current sub-page as plain text. Used by /admin/triage, /admin/settings, /admin/audit.
export function adminCrumbs(currentPage: string): Crumb[] {
  return [{ label: "Administration", href: "/admin" }, { label: currentPage }];
}

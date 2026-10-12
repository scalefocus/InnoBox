// "Coming soon" teasers shown at the top of the /whats-new page (INNOBOX_SPEC.md §13.9).
//
// MAINTENANCE: one entry per feature that the spec already defines but that has not shipped.
// `ids` names the open "⚠ GAP-nn · new feature" markers the entry covers — internal only, never
// rendered. upcoming.test.ts keeps this list and the spec's open new-feature markers in sync in
// both directions: specifying a feature forces a teaser in, and shipping it (which deletes its
// markers) forces the teaser out — its changelog entry announces it instead.
//
// Copy rules: user terms only — no spec section marks, no marker ids, no person, item or
// namespace — and nothing that reads as a promise (no dates, versions or ETAs).

/** Who is shown an entry: everyone, platform or namespace admins, or platform admins only. */
export type UpcomingAudience = "everyone" | "admins" | "platform_admin";

export interface UpcomingEntry {
  ids: string[];
  title: string;
  teaser: string;
  audience: UpcomingAudience;
}

/** The viewer's resolved roles, as the `me` resource reports them. */
export interface UpcomingViewer {
  platformAdmin: boolean;
  namespaceAdmin: readonly string[];
}

export const UPCOMING: UpcomingEntry[] = [];

/** True when an entry applies to a viewer with these roles. */
export function appliesTo(audience: UpcomingAudience, viewer: UpcomingViewer): boolean {
  if (audience === "everyone") return true;
  if (audience === "platform_admin") return viewer.platformAdmin;
  return viewer.platformAdmin || viewer.namespaceAdmin.length > 0;
}

/** The entries to show this viewer, in display order. */
export function upcomingFor(viewer: UpcomingViewer, entries: readonly UpcomingEntry[] = UPCOMING): UpcomingEntry[] {
  return entries.filter((entry) => appliesTo(entry.audience, viewer));
}

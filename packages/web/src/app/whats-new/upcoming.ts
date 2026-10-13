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

export const UPCOMING: UpcomingEntry[] = [
  {
    ids: ["GAP-74"],
    title: "Challenges from outside",
    teaser:
      "Customers and partners will be able to send a challenge through a public form, without an account. Each one is reviewed before it joins the list.",
    audience: "everyone",
  },
  {
    ids: ["GAP-76"],
    title: "E-mail digests",
    teaser: "Prefer fewer e-mails? Get a daily or weekly summary of what you follow instead of one e-mail per update.",
    audience: "everyone",
  },
  {
    ids: ["GAP-77"],
    title: "Trash and restore",
    teaser: "Deleted challenges and solutions will wait in a trash for 30 days, so a mistaken delete can be undone.",
    audience: "platform_admin",
  },
  {
    ids: ["GAP-78"],
    title: "Connect your AI agent",
    teaser:
      "Once an administrator turns it on, you can connect an AI assistant such as Claude to search challenges and submit challenges, solutions and comments as you, after you approve it in your browser. Your first steps with an agent earn new badges.",
    audience: "everyone",
  },
];

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

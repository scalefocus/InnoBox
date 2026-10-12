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
    ids: ["GAP-73"],
    title: "Points, levels and badges",
    teaser:
      "Earn points when your challenges and solutions move forward, level up, and collect badges for your milestones. You can choose whether others see them.",
    audience: "everyone",
  },
  {
    ids: ["GAP-59", "GAP-60", "GAP-61"],
    title: "Update notice",
    teaser:
      "A small card after each release tells you what changed since your last visit, with a link straight to the entries you missed.",
    audience: "everyone",
  },
  {
    ids: ["GAP-62", "GAP-63", "GAP-64"],
    title: "Have your say",
    teaser:
      "A short, anonymous survey about how InnoBox works for you. It asks now and then, and you can also open it yourself from the menu or your profile.",
    audience: "everyone",
  },
  {
    ids: ["GAP-72"],
    title: "Discussion summaries",
    teaser: "A short summary of long comment threads, with the open questions still being discussed.",
    audience: "everyone",
  },
  {
    ids: ["GAP-65", "GAP-66"],
    title: "Survey results",
    teaser: "Scores and comments from the feedback survey, by feature and by role, with trends over time.",
    audience: "platform_admin",
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

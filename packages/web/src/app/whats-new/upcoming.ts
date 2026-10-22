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
    ids: ["GAP-81"],
    title: "Co-authors",
    teaser:
      "Write a challenge or a solution together with up to four colleagues. Everyone on the team can edit it, and everyone earns the credit when it succeeds.",
    audience: "everyone",
  },
  {
    ids: ["GAP-82"],
    title: "Impact tracking",
    teaser:
      "Record what an implemented solution actually delivered, such as hours saved, costs avoided or revenue won, and see the value delivered so far on Home.",
    audience: "everyone",
  },
  {
    ids: ["GAP-83"],
    title: "This affects me too",
    teaser: "Tell reviewers a challenge affects you, and how many people, so the problems with the widest reach stand out in triage.",
    audience: "everyone",
  },
  {
    ids: ["GAP-84"],
    title: "Mark as duplicate",
    teaser:
      "Close a duplicate challenge in one step: its followers move to the original, and its author is told where the discussion continues.",
    audience: "admins",
  },
  {
    ids: ["GAP-85"],
    title: "Stuck-item alerts",
    teaser:
      "See how long each item has waited in its status, highlighted against your targets, plus a weekly e-mail listing what is stuck.",
    audience: "admins",
  },
  {
    ids: ["GAP-86"],
    title: "Implementation board",
    teaser:
      "Follow accepted solutions on a board, from acceptance to implementation. Reviewers move the cards along; everyone else sees the roadmap.",
    audience: "everyone",
  },
  {
    ids: ["GAP-87"],
    title: "Invite a solver",
    teaser: "Know someone who could crack a challenge? Invite them to propose a solution, and earn a badge when they do.",
    audience: "everyone",
  },
  {
    ids: ["GAP-88"],
    title: "Topics",
    teaser: "Follow the topics you care about and hear when a new challenge in one of them opens for solutions.",
    audience: "everyone",
  },
  {
    ids: ["GAP-89"],
    title: "Campaigns",
    teaser:
      "Time-boxed calls for challenges on one theme, such as cutting cloud costs, with a banner on Home while they run and a report when they close.",
    audience: "everyone",
  },
  {
    ids: ["GAP-90"],
    title: "Your year in review",
    teaser: "A personal recap of your year in InnoBox: what you raised, what you solved, and the badges you earned along the way.",
    audience: "everyone",
  },
  {
    ids: ["GAP-91"],
    title: "Namespace pulse",
    teaser:
      "A weekly AI-written brief of your namespace: emerging themes, items that have waited longest, and challenges that look like duplicates.",
    audience: "admins",
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

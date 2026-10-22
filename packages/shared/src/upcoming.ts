// "Coming soon" teasers shown at the top of the /whats-new page (INNOBOX_SPEC.md §13.9) — client-safe,
// also at `@innobox/shared/upcoming`. It lives in the shared package so the worker can read it too:
// the §38.9 sweep tells a shipped teaser's voters that it has arrived.
//
// MAINTENANCE: one entry per feature that the spec already defines but that has not shipped.
// `key` is a permanent kebab-case slug that votes are stored against (§38.2): unique, and never
// reused once retired. `ids` names the open "⚠ GAP-nn · new feature" markers the entry covers.
// Both are internal only, never rendered. upcoming.test.ts keeps this list and the spec's open
// new-feature markers in sync in both directions: specifying a feature forces a teaser in, and
// shipping it (which deletes its markers) forces the teaser out — its changelog entry announces it
// instead, and the worker tells its voters on its next start.
//
// A teaser taken out WITHOUT shipping (a feature descoped from the spec) must have its key added to
// DROPPED_UPCOMING_KEYS in the same commit, so its votes are cleared silently instead of being
// announced as "now available".
//
// Copy rules: user terms only — no spec section marks, no marker ids, no person, item or
// namespace — and nothing that reads as a promise (no dates, versions or ETAs).

/** Who is shown an entry: everyone, platform or namespace admins, or platform admins only. */
export type UpcomingAudience = "everyone" | "admins" | "platform_admin";

export const UPCOMING_AUDIENCES: readonly UpcomingAudience[] = ["everyone", "admins", "platform_admin"];

export interface UpcomingEntry {
  key: string;
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
    key: "co-authors",
    ids: ["GAP-81"],
    title: "Co-authors",
    teaser:
      "Write a challenge or a solution together with up to four colleagues. Everyone on the team can edit it, and everyone earns the credit when it succeeds.",
    audience: "everyone",
  },
  {
    key: "impact-tracking",
    ids: ["GAP-82"],
    title: "Impact tracking",
    teaser:
      "Record what an implemented solution actually delivered, such as hours saved, costs avoided or revenue won, and see the value delivered so far on Home.",
    audience: "everyone",
  },
  {
    key: "affects-me-too",
    ids: ["GAP-83"],
    title: "This affects me too",
    teaser: "Tell reviewers a challenge affects you, and how many people, so the problems with the widest reach stand out in triage.",
    audience: "everyone",
  },
  {
    key: "mark-as-duplicate",
    ids: ["GAP-84"],
    title: "Mark as duplicate",
    teaser:
      "Close a duplicate challenge in one step: its followers move to the original, and its author is told where the discussion continues.",
    audience: "admins",
  },
  {
    key: "stuck-item-alerts",
    ids: ["GAP-85"],
    title: "Stuck-item alerts",
    teaser:
      "See how long each item has waited in its status, highlighted against your targets, plus a weekly e-mail listing what is stuck.",
    audience: "admins",
  },
  {
    key: "implementation-board",
    ids: ["GAP-86"],
    title: "Implementation board",
    teaser:
      "Follow accepted solutions on a board, from acceptance to implementation. Reviewers move the cards along; everyone else sees the roadmap.",
    audience: "everyone",
  },
  {
    key: "invite-a-solver",
    ids: ["GAP-87"],
    title: "Invite a solver",
    teaser: "Know someone who could crack a challenge? Invite them to propose a solution, and earn a badge when they do.",
    audience: "everyone",
  },
  {
    key: "campaigns",
    ids: ["GAP-89"],
    title: "Campaigns",
    teaser:
      "Time-boxed calls for challenges on one theme, such as cutting cloud costs, with a banner on Home while they run and a report when they close.",
    audience: "everyone",
  },
  {
    key: "year-in-review",
    ids: ["GAP-90"],
    title: "Your year in review",
    teaser: "A personal recap of your year in InnoBox: what you raised, what you solved, and the badges you earned along the way.",
    audience: "everyone",
  },
  {
    key: "namespace-pulse",
    ids: ["GAP-91"],
    title: "Namespace pulse",
    teaser:
      "A weekly AI-written brief of your namespace: emerging themes, items that have waited longest, and challenges that look like duplicates.",
    audience: "admins",
  },
];

/** Keys of teasers removed from UPCOMING without shipping (§38.2): their votes are cleared silently. */
export const DROPPED_UPCOMING_KEYS: readonly string[] = [];

/** A teaser key: lower-case words joined by single hyphens. */
export const UPCOMING_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isUpcomingAudience(v: unknown): v is UpcomingAudience {
  return typeof v === "string" && (UPCOMING_AUDIENCES as readonly string[]).includes(v);
}

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

/** The teaser with this key, if it is still in the list. */
export function upcomingByKey(key: string, entries: readonly UpcomingEntry[] = UPCOMING): UpcomingEntry | undefined {
  return entries.find((entry) => entry.key === key);
}

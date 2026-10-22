"use client";
// Badges and markers shared by the Challenges gallery's card AND list views (INNOBOX_SPEC.md
// §13.1: "the list never shows less state than the card"). Each piece renders identically in both
// views — same wording, condition and masking — so a new badge is added HERE once and shows up
// in both presentations:
//   - ChallengeNewTag      — the "new since your last visit" tag (card corner / full-height row tab)
//   - ChallengeAuthorName  — the masked author name (§9) and the co-author "+N" (§39.7)
//   - ChallengeAuthorBubbles — the author's bubble, or up to three stacked bubbles for a team (§39.7)
//   - ChallengeStateBadges — state chips next to the title/status: the Committee pick chip
//                            (§13.10) and the visibility-gated "Duplicate of CH-<n>" (§7.4)
//                            belong here
import { teamAriaLabel } from "@innobox/shared/coauthors";
import { useDateFmt } from "@/components/DateFormat";
import { TeamBubbles, TeamNames, teamOf, type TeamPerson } from "@/components/TeamByline";

/** The subset of the list payload these badges read. The page's list item satisfies it. */
export interface ChallengeBadgeData {
  createdAt: string;
  isNew: boolean;
  /** The first member of the team (§39.7). */
  author: TeamPerson;
  /** §39.7: every member in order — the single masked shape for an anonymous or external item. */
  authors?: TeamPerson[];
}

/** §13.1: created since this viewer last left the Challenges surface — exactly the items the
 *  nav bubble counts. The tooltip carries when it appeared. Positioned by its container's CSS. */
export function ChallengeNewTag({ challenge }: { challenge: ChallengeBadgeData }) {
  const fmt = useDateFmt();
  if (!challenge.isNew) return null;
  return (
    <span className="chip-new" title={`New since your last visit — submitted ${fmt.dateTime(challenge.createdAt)}`} aria-label="New since your last visit">
      new
    </span>
  );
}

/** The author's name as shown on a card or row — "Anonymous" when masked (invariant 3, §9) — and
 *  "+N" for the rest of a team (§39.7). */
export function ChallengeAuthorName({ challenge }: { challenge: ChallengeBadgeData }) {
  return <TeamNames authors={teamOf(challenge)} />;
}

/** The author's bubble, or the team's first three stacked (§39.7), labelled as one group. */
export function ChallengeAuthorBubbles({ challenge }: { challenge: ChallengeBadgeData }) {
  const authors = teamOf(challenge);
  return (
    <span className="team-bubbles" role="group" aria-label={teamAriaLabel(authors)}>
      <TeamBubbles authors={authors} />
    </span>
  );
}

/** State chips that accompany the title/status on both views. None exist yet; this is the single
 *  mount point so the card and the list row always carry the same set. */
export function ChallengeStateBadges({ challenge }: { challenge: ChallengeBadgeData }) {
  void challenge;
  return null;
}

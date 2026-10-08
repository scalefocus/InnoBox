"use client";
// Badges and markers shared by the Challenges gallery's card AND list views (INNOBOX_SPEC.md
// §13.1: "the list never shows less state than the card"). Each piece renders identically in both
// views — same wording, condition and masking — so a new badge is added HERE once and shows up
// in both presentations:
//   - ChallengeNewTag      — the "new since your last visit" tag (card corner / full-height row tab)
//   - ChallengeAuthorName  — the masked author name (§9); the co-author "+N" (§6.5) belongs here
//   - ChallengeStateBadges — state chips next to the title/status: the Committee pick chip
//                            (§13.10) and the visibility-gated "Duplicate of CH-<n>" (§7.4)
//                            belong here
import { useDateFmt } from "@/components/DateFormat";

/** The subset of the list payload these badges read. The page's list item satisfies it. */
export interface ChallengeBadgeData {
  createdAt: string;
  isNew: boolean;
  author: { userId: string | null; displayName: string; anonymous: boolean };
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

/** The author's name as shown on a card or row — "Anonymous" when masked (invariant 3, §9). */
export function ChallengeAuthorName({ challenge }: { challenge: ChallengeBadgeData }) {
  return <>{challenge.author.anonymous ? "Anonymous" : challenge.author.displayName}</>;
}

/** State chips that accompany the title/status on both views. None exist yet; this is the single
 *  mount point so the card and the list row always carry the same set. */
export function ChallengeStateBadges({ challenge }: { challenge: ChallengeBadgeData }) {
  void challenge;
  return null;
}

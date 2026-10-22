"use client";
// A co-author team as the cards, rows, search results and Home show it (INNOBOX_SPEC.md §39.7, the
// compact form): up to three overlapping small bubbles (the first three members), then the first
// member's name, then "+N" when there are more. Each bubble is an ordinary AvatarBubble with its
// §13.8 hover card; the group's aria-label reads "Ana Petrova and 2 co-authors". A solo item is one
// bubble and one name, exactly as before; an anonymous or external item is the single masked shape
// the server sent (§9, §24.6) — this component never sees more than that.
import { teamAriaLabel, COMPACT_BUBBLES_MAX } from "@innobox/shared/coauthors";
import { AvatarBubble, type AvatarSize } from "./AvatarBubble";

/** A member as the payloads carry it (the masked-author shape). */
export interface TeamPerson {
  userId: string | null;
  displayName: string;
  anonymous: boolean;
  active?: boolean;
  scrubbed?: boolean;
  external?: boolean;
}

/** `authors` when the payload has it, else the single `author` (older shapes, tests). */
export function teamOf(item: { author: TeamPerson; authors?: readonly TeamPerson[] }): readonly TeamPerson[] {
  return item.authors && item.authors.length > 0 ? item.authors : [item.author];
}

/** One member's bubble. */
export function PersonBubble({ person, size = "sm" }: { person: TeamPerson; size?: AvatarSize }) {
  return (
    <AvatarBubble
      size={size}
      userId={person.userId}
      displayName={person.displayName}
      anonymous={person.anonymous}
      external={person.external === true}
      deactivated={person.active === false}
      scrubbed={person.scrubbed === true}
    />
  );
}

/** The stacked bubbles of the first three members — one bubble for a solo item. */
export function TeamBubbles({ authors, size = "sm" }: { authors: readonly TeamPerson[]; size?: AvatarSize }) {
  if (authors.length <= 1) return authors[0] ? <PersonBubble person={authors[0]} size={size} /> : null;
  return (
    <span className="team-stack">
      {authors.slice(0, COMPACT_BUBBLES_MAX).map((person, i) => (
        <span key={person.userId ?? `p${i}`} className="team-stack-item">
          <PersonBubble person={person} size={size} />
        </span>
      ))}
    </span>
  );
}

/** The first member's name — "Anonymous" when masked — then "+N" when there are more. */
export function TeamNames({ authors }: { authors: readonly TeamPerson[] }) {
  const first = authors[0];
  if (!first) return null;
  const more = authors.length - 1;
  return (
    <>
      {first.anonymous ? "Anonymous" : first.displayName}
      {more > 0 && <span className="team-more"> +{more}</span>}
    </>
  );
}

/** Bubbles and names as one labelled group — the usual byline. */
export function TeamByline({ authors, className }: { authors: readonly TeamPerson[]; className?: string }) {
  return (
    <span className={`team-byline${className ? ` ${className}` : ""}`} role="group" aria-label={teamAriaLabel(authors)}>
      <TeamBubbles authors={authors} />
      <span className="team-byline-names">
        <TeamNames authors={authors} />
      </span>
    </span>
  );
}

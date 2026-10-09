"use client";
// Avatar bubble (INNOBOX_SPEC.md §3.1, §13.6): the one component rendered on every surface that
// names a user. Photo (when present) is served ONLY through the authenticated gateway
// GET /api/users/:id/photo; on 404/error it falls back to the initials bubble underneath.
//
// Anonymity (§9, invariant 3): callers pass `userId={null}` for anonymous authors (that is what
// maskAuthor returns), which renders the fixed generic bubble — no photo, no initials, no
// per-user color, so nothing fingerprints the author. A real userId is the only thing that ever
// triggers a photo request, so an anonymous author's photo can never be fetched.
//
// Directory hover card (§13.8): a bubble with a real userId is also the card's trigger — it becomes
// focusable, loses its native `title` (a browser tooltip would race the card on the same element)
// and opens the card on mouse-hover or keyboard focus. Bubbles with no id — anonymous authors,
// deleted/unknown actors — and the surfaces that opt out via `noCard` keep their `title`, gain no
// tab stop, and issue no card request.
import { useState } from "react";
import { avatarInitials, avatarColorIndex, avatarVariant } from "@innobox/shared/avatars";
import { useDirectoryCard } from "./DirectoryCard";

export type AvatarSize = "sm" | "md" | "lg";

export function AvatarBubble({
  userId,
  displayName,
  size = "sm",
  anonymous = false,
  deactivated = false,
  title,
  noCard = false,
  self = false,
}: {
  /** The user's id — the key for the photo + fallback color. Null = no linkable identity
   *  (anonymous author, deleted/"Deleted User", or an unknown actor): renders a neutral bubble
   *  with no photo. */
  userId: string | null;
  /** Drives the initials and the accessible label. "" is fine (yields "?"). */
  displayName: string;
  size?: AvatarSize;
  /** Force the generic anonymous bubble regardless of userId (§9). */
  anonymous?: boolean;
  /** Greyed initials bubble, no photo — a SCIM-deactivated user (§3.1). */
  deactivated?: boolean;
  /** Overrides the hover/aria label (defaults to the display name, or "Anonymous"). */
  title?: string;
  /** Opt out of the directory hover card (§13.8) — the account-menu trigger, which opens a menu
   *  on the same element, and bubbles inside an already-open popover (§7.3 assignee search,
   *  §14.1 inline assignee editor), where a card would nest a popover in a popover. */
  noCard?: boolean;
  /** This bubble is the signed-in user's own — the card links to /profile. */
  self?: boolean;
}) {
  const [imgFailed, setImgFailed] = useState(false);

  // Card-bearing only for a real, non-anonymous identity on a surface that hasn't opted out. The
  // gate is here (not inside the card) so an anonymous bubble carries no handlers and no tab stop.
  const cardEligible = !noCard && !anonymous && userId !== null && displayName !== "Anonymous";
  const { triggerProps, card } = useDirectoryCard({
    userId,
    displayName,
    enabled: cardEligible,
    self,
    // Rendered inside the card at medium size, with the card itself disabled (no recursion).
    avatar: <AvatarBubble size="md" userId={userId} displayName={displayName} deactivated={deactivated} noCard />,
  });

  const variant = avatarVariant({ userId, displayName, anonymous, deactivated });

  // Generic anonymous bubble: no photo, no initials, no per-user color (§9/§13.6).
  if (variant === "anon") {
    return (
      <span className={`avatar avatar-${size} avatar-anon`} title={title ?? "Anonymous"} aria-label={title ?? "Anonymous"} role="img">
        <PersonGlyph />
      </span>
    );
  }

  const label = title ?? displayName ?? "";
  const initials = avatarInitials(displayName);

  // A scrubbed "Deleted User" (§3 erasure): the neutral bubble — no photo, no initials, no
  // per-user color. A scrubbed row that still carries its id keeps the card ("No directory
  // information", §13.8); an id-less one never has one.
  if (variant === "deleted") {
    return (
      <>
        <span
          className={`avatar avatar-${size} avatar-off avatar-deleted`}
          title={triggerProps ? undefined : label}
          aria-label={label}
          role="img"
          {...(triggerProps ?? {})}
        >
          <PersonGlyph />
        </span>
        {card}
      </>
    );
  }

  // No linkable id or a deactivated user (§3.1 photo dropped) → greyed initials, never a photo.
  // A deactivated user still gets a card (it names the state); a user with no id never does.
  if (variant === "off" || userId === null) {
    return (
      <>
        <span
          className={`avatar avatar-${size} avatar-off`}
          title={triggerProps ? undefined : label}
          aria-label={label}
          role="img"
          {...(triggerProps ?? {})}
        >
          {initials}
        </span>
        {card}
      </>
    );
  }

  // Real user: colored initials bubble with the gateway photo layered on top; the photo is
  // hidden if it 404s (no photo cached) or fails to decode, leaving the initials visible.
  return (
    <>
      <span
        className={`avatar avatar-${size} avatar-c${avatarColorIndex(userId)}`}
        title={triggerProps ? undefined : label}
        aria-label={label}
        role="img"
        {...(triggerProps ?? {})}
      >
        {initials}
        {!imgFailed && (
          // eslint-disable-next-line @next/next/no-img-element -- authenticated gateway URL, not a static asset; Next/Image can't send session cookies here
          <img
            className="avatar-img"
            src={`/api/users/${userId}/photo`}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setImgFailed(true)}
          />
        )}
      </span>
      {card}
    </>
  );
}

/** Neutral person silhouette for the anonymous bubble — deliberately identical for every
 *  anonymous author (§9). */
function PersonGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c1.3-3.3 3.9-4.8 7-4.8s5.7 1.5 7 4.8" />
    </svg>
  );
}

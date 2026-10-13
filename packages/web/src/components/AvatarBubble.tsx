"use client";
// Avatar bubble (INNOBOX_SPEC.md §3.1, §13.6): the one component rendered on every surface that
// names a user. Photo (when present) is served ONLY through the authenticated gateway
// GET /api/users/:id/photo; on 404/error it falls back to the initials bubble underneath.
//
// Anonymity (§9, invariant 3): callers pass `userId={null}` for anonymous authors (that is what
// maskAuthor returns), which renders the fixed generic bubble — no photo, no initials, no
// per-user color, so nothing fingerprints the author. A real userId is the only thing that ever
// triggers a photo request, so an anonymous author's photo can never be fetched. A challenge
// accepted from the public form (§24.6, `external`) has no author at all: the same neutral bubble,
// labelled with its "External submission" display name instead of "Anonymous".
//
// Directory hover card (§13.8): a bubble with a real userId is also the card's trigger — it becomes
// focusable, loses its native `title` (a browser tooltip would race the card on the same element)
// and opens the card on mouse-hover or keyboard focus. Bubbles with no id — anonymous authors,
// deleted/unknown actors — and the surfaces that opt out via `noCard` keep their `title`, gain no
// tab stop, and issue no card request.
//
// Level-progress ring (§23.6): callers that hold a §23 level block pass `ring`; it renders only on
// medium and large bubbles of a real, active, non-scrubbed user — never on small list bubbles, nor
// on an anonymous, deactivated or scrubbed one. Decorative: the label gains ", level N".
import { useState, type ReactNode } from "react";
import { avatarInitials, avatarColorIndex, avatarVariant } from "@innobox/shared/avatars";
import { useDirectoryCard } from "./DirectoryCard";

export type AvatarSize = "sm" | "md" | "lg";

/** The §23 level progress the ring draws (0…1), and the level for the label. */
export interface AvatarRing {
  level: number;
  progress: number;
  /** Level 10 — a full gold ring. */
  top?: boolean;
}

/** Thin ring around the bubble, filled clockwise from 12 o'clock to the level progress. */
function withRing(bubble: ReactNode, ring: AvatarRing): ReactNode {
  const pct = ring.top ? 100 : Math.round(Math.min(1, Math.max(0, ring.progress)) * 100);
  return (
    <span className={`avatar-ring-wrap${ring.top ? " is-top" : ""}`}>
      <svg className="avatar-ring" viewBox="0 0 36 36" aria-hidden="true">
        <circle className="avatar-ring-track" cx="18" cy="18" r="16.5" pathLength={100} />
        <circle className="avatar-ring-arc" cx="18" cy="18" r="16.5" pathLength={100} strokeDasharray={`${pct} 100`} />
      </svg>
      {bubble}
    </span>
  );
}

export function AvatarBubble({
  userId,
  displayName,
  size = "sm",
  anonymous = false,
  external = false,
  deactivated = false,
  scrubbed = false,
  title,
  noCard = false,
  ring = null,
}: {
  /** The user's id — the key for the photo + fallback color. Null = no linkable identity
   *  (anonymous author, or an unknown actor): renders a neutral bubble
   *  with no photo. */
  userId: string | null;
  /** Drives the initials and the accessible label. "" is fine (yields "?"). */
  displayName: string;
  size?: AvatarSize;
  /** Force the generic anonymous bubble regardless of userId (§9). */
  anonymous?: boolean;
  /** §24.6: an authorless challenge from the public form — the neutral bubble, labelled with the
   *  display name ("External submission · <company>"). */
  external?: boolean;
  /** Greyed initials bubble, no photo — a SCIM-deactivated user (§3.1). */
  deactivated?: boolean;
  /** The neutral "Deleted User" bubble — a GDPR-scrubbed user (§3 erasure). Every person payload
   *  carries this flag explicitly; the bubble never infers it from the display name (§13.6). */
  scrubbed?: boolean;
  /** Overrides the hover/aria label (defaults to the display name, or "Anonymous"). */
  title?: string;
  /** Opt out of the directory hover card (§13.8) — the account-menu trigger, which opens a menu
   *  on the same element, and bubbles inside an already-open popover (§7.3 assignee search,
   *  §14.1 inline assignee editor), where a card would nest a popover in a popover. */
  noCard?: boolean;
  /** §23.6 level-progress ring — only drawn on md/lg bubbles of a real, active user. */
  ring?: AvatarRing | null;
}) {
  const [imgFailed, setImgFailed] = useState(false);

  // Card-bearing only for a real, non-anonymous identity on a surface that hasn't opted out. The
  // gate is here (not inside the card) so an anonymous bubble carries no handlers and no tab stop.
  const cardEligible = !noCard && !anonymous && !external && userId !== null && displayName !== "Anonymous";
  const { triggerProps, card } = useDirectoryCard({
    userId,
    displayName,
    enabled: cardEligible,
    // Rendered inside the card at medium size, with the card itself disabled (no recursion).
    avatar: (cardRing) => (
      <AvatarBubble size="md" userId={userId} displayName={displayName} deactivated={deactivated} scrubbed={scrubbed} noCard ring={cardRing} />
    ),
  });

  const variant = avatarVariant({ userId, displayName, anonymous, deactivated, scrubbed });

  // Generic anonymous bubble: no photo, no initials, no per-user color (§9/§13.6). An external
  // submission (§24.6) shares it, under its own label.
  if (variant === "anon" || external) {
    const anonLabel = title ?? (external ? displayName : "Anonymous");
    return (
      <span className={`avatar avatar-${size} avatar-anon`} title={anonLabel} aria-label={anonLabel} role="img">
        <PersonGlyph />
      </span>
    );
  }

  const label = title ?? displayName ?? "";
  const initials = avatarInitials(displayName);

  // A scrubbed user (§3 erasure, the explicit `scrubbed` flag): the neutral bubble — no photo, no initials, no
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
  const ringed = ring && size !== "sm" ? ring : null;
  const ringLabel = ringed ? `${label}, level ${ringed.level}` : label;
  const bubble = (
    <>
      <span
        className={`avatar avatar-${size} avatar-c${avatarColorIndex(userId)}`}
        title={triggerProps ? undefined : label}
        aria-label={ringLabel}
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
  return ringed ? withRing(bubble, ringed) : bubble;
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

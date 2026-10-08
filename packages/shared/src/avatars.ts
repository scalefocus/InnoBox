// Avatar helpers (INNOBOX_SPEC.md §3.1, §13.6): the pure, client-safe pieces of the avatar
// bubble — initials derivation and the deterministic fallback-color index. No DB, no DOM, no
// node-only imports, so this is re-exported from the client-safe `@innobox/shared/avatars`
// subpath and consumed by the React <AvatarBubble> component. The photo itself is served by
// the web gateway (GET /api/users/:id/photo); these helpers only drive the initials fallback.

/** Number of fallback background colors; the CSS defines `.avatar-c0`…`.avatar-c{N-1}` with
 *  light + dark variants (INNOBOX_SPEC.md §13.6). Keep in sync with globals.css. */
export const AVATAR_COLOR_COUNT = 8;

/** First + last initial of a display name (e.g. "Ada Lovelace" → "AL"); a single-word name
 *  uses its first two characters ("Cher" → "CH"); empty/whitespace yields "?". Always upper-
 *  case, at most two characters. Used only for the no-photo fallback bubble (§13.6). */
export function avatarInitials(displayName: string): string {
  const parts = (displayName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    const word = parts[0]!;
    return (word.length >= 2 ? word.slice(0, 2) : word).toUpperCase();
  }
  const first = parts[0]![0]!;
  const last = parts[parts.length - 1]![0]!;
  return (first + last).toUpperCase();
}

/** Deterministic fallback-color index in [0, AVATAR_COLOR_COUNT) from a stable key (the user
 *  id). Stable across sessions and processes — a plain FNV-1a hash, no crypto needed. The
 *  same user always gets the same bubble color. NOT used for anonymous authors (§13.6): those
 *  render the fixed generic bubble with no per-user color, so callers pass a color index only
 *  when they have a real, non-anonymous user id. */
export function avatarColorIndex(key: string): number {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % AVATAR_COLOR_COUNT;
}

/** The display name a GDPR erasure ("Delete user info", §3) writes onto the user row. */
export const DELETED_USER_DISPLAY_NAME = "Deleted User";

export type AvatarVariant = "anon" | "deleted" | "off" | "color";

/** Which §13.6 bubble a user renders as, decided from the data every payload already carries:
 *  - `anon` — the generic anonymous bubble (§9), identical for every anonymous author;
 *  - `deleted` — the neutral bubble for a scrubbed "Deleted User": erasure always deactivates
 *    the account, so an inactive (or id-less) row named "Deleted User" is a scrubbed one and
 *    gets no initials and no per-user color;
 *  - `off` — the greyed initials bubble for a deactivated user (photo dropped, §3.1) or an
 *    id-less actor;
 *  - `color` — the palette-colored initials bubble (photo layered on top when present). */
export function avatarVariant(input: {
  userId: string | null;
  displayName: string;
  anonymous?: boolean;
  deactivated?: boolean;
}): AvatarVariant {
  if (input.anonymous || (input.userId === null && input.displayName === "Anonymous")) return "anon";
  const inactive = input.userId === null || input.deactivated === true;
  if (inactive && input.displayName === DELETED_USER_DISPLAY_NAME) return "deleted";
  if (inactive) return "off";
  return "color";
}

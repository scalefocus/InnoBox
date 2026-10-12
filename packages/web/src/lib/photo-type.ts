// Content-type sniffing for cached Entra profile photos (INNOBOX_SPEC.md §3.1). Reconciliation
// stores the Graph bytes as-is — JPEG or PNG, whichever Graph returns — and keeps no separate
// type column, so the photo gateway derives the type from the stored bytes' magic number.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export type PhotoContentType = "image/png" | "image/jpeg";

/** The content type of a stored profile photo: `image/png` for the PNG signature, otherwise
 *  `image/jpeg` (JPEG's FF D8 FF marker, and the fallback for anything unrecognized — unreadable
 *  bytes then simply fail to decode and the client falls back to the initials bubble). */
export function photoContentType(bytes: Uint8Array): PhotoContentType {
  if (bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return "image/png";
  return "image/jpeg";
}

const QUOTED_ETAG = /^(W\/)?"[^"]*"$/;

/** The stored Graph photo etag as one well-formed entity tag (§3.1): a value that is already
 *  quoted — strong `"…"`, or weak `W/"…"` — passes through unchanged; only an unquoted value is
 *  wrapped in quotes (with any stray `"` dropped, which an entity tag cannot carry). Blank or
 *  absent → undefined (no ETag header). */
export function photoEtag(stored: string | null | undefined): string | undefined {
  const value = stored?.trim();
  if (!value) return undefined;
  if (QUOTED_ETAG.test(value)) return value;
  return `"${value.replace(/"/g, "")}"`;
}

/** Whether an `If-None-Match` header names `etag` — compared against the same form
 *  `photoEtag` sends. Accepts a comma-separated list and the `*` wildcard. */
export function ifNoneMatchHits(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((t) => {
    const tag = t.trim();
    return tag === "*" || tag === etag;
  });
}

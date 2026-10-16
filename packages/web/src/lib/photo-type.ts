// Content-type sniffing for cached Entra profile photos (INNOBOX_SPEC.md §3.1). Reconciliation
// stores the Graph bytes as-is — JPEG or PNG, whichever Graph returns — and keeps no separate
// type column, so the photo gateway derives the type from the stored bytes' magic number. Also
// the gateway's response headers: like the §11 attachment gateway, a served photo is sandboxed
// (`nosniff`, `sandbox; default-src 'none'`, inline disposition) so bytes that are not a real
// image can never execute in the app's origin whatever the sniff concluded.
import { ATTACHMENT_DOWNLOAD_CSP } from "./security-headers";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export type PhotoContentType = "image/png" | "image/jpeg";

/** A served photo (and its 304) is private to the signed-in browser and revalidated hourly. */
export const PHOTO_CACHE_CONTROL = "private, max-age=3600, must-revalidate";

/** §3.1: the 200 response's headers — the sniffed type, the private one-hour cache, the entity
 *  tag when there is one, and the three hardening headers shared with the §11 download gateway. */
export function photoResponseHeaders(bytes: Uint8Array, etag: string | undefined): Record<string, string> {
  return {
    "content-type": photoContentType(bytes),
    "cache-control": PHOTO_CACHE_CONTROL,
    "x-content-type-options": "nosniff",
    "content-security-policy": ATTACHMENT_DOWNLOAD_CSP,
    "content-disposition": 'inline; filename="photo"',
    ...(etag ? { etag } : {}),
  };
}

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

/** §3.1: the no-photo `404` is cacheable for 5 minutes, so a screen of photo-less users does not
 *  re-ask the gateway on every render; a newly synced photo shows up at most that much later. */
export const NO_PHOTO_CACHE_CONTROL = "private, max-age=300";

/** The gateway's answer for a user with no cached photo (or a deactivated one): an empty `404`
 *  the browser may keep for `NO_PHOTO_CACHE_CONTROL`. */
export function noPhotoResponse(): Response {
  return new Response(null, { status: 404, headers: { "cache-control": NO_PHOTO_CACHE_CONTROL } });
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

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

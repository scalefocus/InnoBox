// Pure rules behind §11 "Drop and paste" (INNOBOX_SPEC.md §11 "UI"): how a picked, dropped or
// pasted batch of files is pre-checked before it joins an upload control's queue, when a paste
// attaches at all, which control a paste goes to, and how a generic clipboard name is replaced.
// The server stays authoritative for every limit — these only spare the user a doomed upload.
// Client-safe: no imports.

/** The §11 extension allowlist, mirrored for the browser (a unit test pins it to the server's).
 *  The server also checks the MIME and the leading bytes; the browser checks the name only. */
export const ATTACHMENT_EXTENSIONS: readonly string[] = [
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf",
  "txt", "csv", "md",
  "png", "jpg", "jpeg", "gif", "webp",
  "zip",
];

/** The file input's `accept` hint. */
export const ATTACHMENT_ACCEPT = ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(",");

function extensionOf(name: string): string {
  const n = name.trim().toLowerCase();
  const dot = n.lastIndexOf(".");
  return dot < 0 || dot === n.length - 1 ? "" : n.slice(dot + 1);
}

export interface IntakeCandidate {
  name: string;
  size: number;
  /** A dropped folder (the browser hands it over as a File with no usable bytes). */
  isDirectory?: boolean;
}

export interface IntakeLimits {
  /** null while the config is still loading — the server enforces it either way. */
  maxUploadSizeMb: number | null;
  maxPerItem: number | null;
  /** Files already attached plus those queued or uploading on this control. */
  taken: number;
}

export interface Skipped {
  name: string;
  reason: string;
}

/** Queue what passes, in the order given and up to the per-item cap; skip the rest with a reason. */
export function precheckFiles<T extends IntakeCandidate>(files: readonly T[], limits: IntakeLimits): { accepted: T[]; skipped: Skipped[] } {
  const accepted: T[] = [];
  const skipped: Skipped[] = [];
  let slots = limits.maxPerItem === null ? Infinity : Math.max(0, limits.maxPerItem - limits.taken);
  for (const f of files) {
    if (f.isDirectory) skipped.push({ name: f.name, reason: "folders can't be attached" });
    else if (!ATTACHMENT_EXTENSIONS.includes(extensionOf(f.name))) skipped.push({ name: f.name, reason: "file type not allowed" });
    else if (limits.maxUploadSizeMb !== null && f.size > limits.maxUploadSizeMb * 1024 * 1024)
      skipped.push({ name: f.name, reason: `over ${limits.maxUploadSizeMb} MB` });
    else if (slots <= 0) skipped.push({ name: f.name, reason: `only ${limits.maxPerItem} files can be attached` });
    else {
      accepted.push(f);
      slots--;
    }
  }
  return { accepted, skipped };
}

/** The one combined message for a batch's skipped files, or null when none were skipped. */
export function skippedMessage(skipped: readonly Skipped[]): string | null {
  if (skipped.length === 0) return null;
  return `Skipped: ${skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}`;
}

/** The polite live-region announcement for a batch. */
export function intakeAnnouncement(added: number, skipped: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} ${added === 1 ? "file" : "files"} added`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts.join(", ");
}

/** Only a drag that carries files raises the overlay; dragged text, links and page images don't. */
export function dragCarriesFiles(types: readonly string[] | null | undefined): boolean {
  return !!types && Array.from(types).includes("Files");
}

/** A paste attaches only when the clipboard carries files and NO text — Word, Excel and Outlook
 *  put a rendered image alongside copied text, and that must stay an ordinary text paste. */
export function pasteAttaches(types: readonly string[], fileCount: number): boolean {
  if (fileCount === 0) return false;
  return !types.some((t) => t === "text/plain" || t === "text/html" || t === "text/uri-list" || t === "text/rtf");
}

export type PasteRoute = { kind: "target"; id: string } | { kind: "ambiguous" } | { kind: "none" };

/** A paste goes to the control in the focused element's form/card; with focus elsewhere, to the
 *  page's only available control; with several available, nowhere (the caller says why). */
export function routePaste(focusedTargetId: string | null, availableIds: readonly string[]): PasteRoute {
  if (focusedTargetId !== null && availableIds.includes(focusedTargetId)) return { kind: "target", id: focusedTargetId };
  if (availableIds.length === 1) return { kind: "target", id: availableIds[0]! };
  return availableIds.length === 0 ? { kind: "none" } : { kind: "ambiguous" };
}

export const PASTE_AMBIGUOUS_MESSAGE = "Click into the form you want to attach to, then paste";

const GENERIC_CLIPBOARD_NAME = /^(image|blob|untitled)?(\.[a-z0-9]+)?$/i;

const EXT_BY_MIME: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const pad = (n: number) => String(n).padStart(2, "0");

/** A pasted file with the browser's generic clipboard name (`image.png`, or none at all) becomes
 *  `pasted-image-YYYY-MM-DD-HHMMSS.<ext>` in the viewer's LOCAL time — a label shown back to
 *  them, not a stored timestamp. A real file (copied in Explorer/Finder) keeps its name. */
export function pastedFileName(name: string, mime: string, now: Date): string {
  if (!GENERIC_CLIPBOARD_NAME.test(name.trim())) return name;
  const ext = extensionOf(name) || EXT_BY_MIME[mime.toLowerCase()] || "png";
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `pasted-image-${stamp}.${ext}`;
}

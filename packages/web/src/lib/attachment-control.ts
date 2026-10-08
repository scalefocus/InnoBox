// Pure rules behind the one §11 upload control (INNOBOX_SPEC.md §11 "UI"), shared by its three
// surfaces — the challenge form, the solution form, and the detail-page author-edit section —
// so the phases, labels and gates cannot drift between them. Client-safe: no imports.

export type AttachmentScanStatus = "pending" | "clean" | "infected" | "unscannable";

/** The post-upload phase label for a stored file: Scanning… → Ready / Failed scan / Couldn't be
 *  scanned. (The Uploading phase belongs to the in-flight file, before any row exists.) */
export function attachmentPhaseLabel(status: AttachmentScanStatus): string {
  switch (status) {
    case "pending":
      return "Scanning…";
    case "clean":
      return "Ready";
    case "infected":
      return "Failed scan";
    case "unscannable":
      return "Couldn't be scanned";
  }
}

/** The pill class for a phase: neutral while scanning, ok when Ready, danger when it failed. */
export function attachmentPhaseClass(status: AttachmentScanStatus): string {
  if (status === "pending") return "chip";
  if (status === "clean") return "pill pill-ok";
  return "pill pill-danger";
}

/** Uploading shows a progress bar for a chunked file (larger than one chunk) and a spinner for a
 *  single-shot one (≤ the chunk size). */
export function uploadMode(sizeBytes: number, chunkSizeBytes: number): "chunked" | "single" {
  return sizeBytes > chunkSizeBytes ? "chunked" : "single";
}

/** The submission forms' Submit gate: blocked while a file is Uploading, and — only when the
 *  scanner is enforced — while any file is Scanning…, Failed scan, or Couldn't be scanned. With
 *  no scanner the gate lifts and still-pending files may be submitted. */
export function blocksSubmit(input: { uploading: boolean; scanEnforced: boolean; statuses: readonly AttachmentScanStatus[] }): boolean {
  if (input.uploading) return true;
  return input.scanEnforced && input.statuses.some((s) => s !== "clean");
}

/** Poll for a verdict while any of the files this control owns is still scanning. */
export function needsScanPoll(statuses: readonly AttachmentScanStatus[]): boolean {
  return statuses.includes("pending");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

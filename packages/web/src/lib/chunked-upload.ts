// Client-side chunked-upload driver (INNOBOX_SPEC.md §11). For a file larger than the
// configured chunk size: initiate → PUT each slice → complete, all through the server (no
// direct-to-store — invariant 4). Reports byte progress so the field can show a progress bar.
// On any failure the session is aborted and the error surfaced, so the user restarts the file
// (per the approved design). The same abort runs when the user removes the file mid-upload: the
// caller's AbortSignal cancels the in-flight chunk and the session is discarded server-side. Deliberately does NOT import @innobox/shared — this runs in the
// browser bundle, and the slicing math is trivial.

export interface ChunkedUploadTarget {
  parentType: "challenge" | "solution";
  /** Staged (submission forms) — mutually exclusive with parentId. */
  draftKey?: string;
  /** Bound (detail-page author-edit) — mutually exclusive with draftKey. */
  parentId?: string;
}

/** The error thrown when the caller's signal cancels an upload (the user removed the file). */
export function uploadCancelledError(): Error {
  const err = new Error("Upload cancelled");
  err.name = "AbortError";
  return err;
}

/** True for a cancellation (ours, or fetch's own AbortError) — not a failure to surface. */
export function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

async function readError(res: Response, fallback: string): Promise<string> {
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  return j.error ?? fallback;
}

/** Upload `file` in chunks and return the created attachment view. `onProgress` is called with
 *  cumulative bytes uploaded after each part (0 → file.size). Throws on failure (session aborted).
 *  When `signal` fires, the in-flight chunk is cancelled, the session is aborted through the
 *  abort endpoint, and an AbortError is thrown (see `isAbortError`). Initiate and complete are
 *  short and run unsignalled, so the session id is always known and a finished upload is never
 *  left half-committed — a cancel that lands during `complete` is the caller's to undo. */
export async function uploadFileInChunks(
  file: File,
  target: ChunkedUploadTarget,
  onProgress: (uploadedBytes: number, totalBytes: number) => void,
  signal?: AbortSignal,
): Promise<{ attachment: unknown }> {
  if (signal?.aborted) throw uploadCancelledError();
  const initRes = await fetch("/api/attachments/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      parentType: target.parentType,
      draftKey: target.draftKey,
      parentId: target.parentId,
      filename: file.name,
      mime: file.type || "application/octet-stream",
      size: file.size,
    }),
  });
  if (!initRes.ok) throw new Error(await readError(initRes, "Could not start upload"));
  const { uploadId, chunkSizeBytes } = (await initRes.json()) as { uploadId: string; chunkSizeBytes: number };

  const abort = async (): Promise<void> => {
    try {
      await fetch(`/api/attachments/uploads/${uploadId}/abort`, { method: "POST" });
    } catch {
      /* best-effort — the worker GC reaps it after the TTL */
    }
  };

  try {
    let partNumber = 1;
    for (let start = 0; start < file.size; start += chunkSizeBytes) {
      if (signal?.aborted) throw uploadCancelledError();
      const end = Math.min(start + chunkSizeBytes, file.size);
      const res = await fetch(`/api/attachments/uploads/${uploadId}/parts/${partNumber}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: file.slice(start, end),
        signal,
      });
      if (!res.ok) throw new Error(await readError(res, "A chunk failed to upload"));
      onProgress(end, file.size);
      partNumber += 1;
    }
    if (signal?.aborted) throw uploadCancelledError();
    const compRes = await fetch(`/api/attachments/uploads/${uploadId}/complete`, { method: "POST" });
    if (!compRes.ok) throw new Error(await readError(compRes, "Could not finalize upload"));
    return (await compRes.json()) as { attachment: unknown };
  } catch (err) {
    await abort();
    throw err;
  }
}

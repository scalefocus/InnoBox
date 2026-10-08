// Client-side chunked-upload driver (INNOBOX_SPEC.md §11). For a file larger than the
// configured chunk size: initiate → PUT each slice → complete, all through the server (no
// direct-to-store — invariant 4). Reports byte progress so the field can show a progress bar.
// On any failure the session is aborted and the error surfaced, so the user restarts the file
// (per the approved design). Deliberately does NOT import @innobox/shared — this runs in the
// browser bundle, and the slicing math is trivial.

export interface ChunkedUploadTarget {
  parentType: "challenge" | "solution";
  /** Staged (submission forms) — mutually exclusive with parentId. */
  draftKey?: string;
  /** Bound (detail-page author-edit) — mutually exclusive with draftKey. */
  parentId?: string;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  return j.error ?? fallback;
}

/** Upload `file` in chunks and return the created attachment view. `onProgress` is called with
 *  cumulative bytes uploaded after each part (0 → file.size). Throws on failure (session aborted). */
export async function uploadFileInChunks(
  file: File,
  target: ChunkedUploadTarget,
  onProgress: (uploadedBytes: number, totalBytes: number) => void,
): Promise<{ attachment: unknown }> {
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
      const end = Math.min(start + chunkSizeBytes, file.size);
      const res = await fetch(`/api/attachments/uploads/${uploadId}/parts/${partNumber}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: file.slice(start, end),
      });
      if (!res.ok) throw new Error(await readError(res, "A chunk failed to upload"));
      onProgress(end, file.size);
      partNumber += 1;
    }
    const compRes = await fetch(`/api/attachments/uploads/${uploadId}/complete`, { method: "POST" });
    if (!compRes.ok) throw new Error(await readError(compRes, "Could not finalize upload"));
    return (await compRes.json()) as { attachment: unknown };
  } catch (err) {
    await abort();
    throw err;
  }
}

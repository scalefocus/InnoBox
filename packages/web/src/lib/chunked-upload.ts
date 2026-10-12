// Client-side chunked-upload driver (INNOBOX_SPEC.md §11). For a file larger than the
// configured chunk size: initiate → PUT each slice → complete, all through the server (no
// direct-to-store — invariant 4). Reports byte progress so the field can show a progress bar.
// A failed part is retried when the failure is transient — a network error, a 5xx or a 429 — up
// to PART_MAX_ATTEMPTS in all, waiting PART_RETRY_DELAYS_MS between attempts (re-sending a part
// number replaces it server-side). Any other 4xx is final. Only when a part is out of attempts is
// the session aborted and the error surfaced, so the user restarts the file. The same abort runs
// when the user cancels mid-upload: the caller's AbortSignal stops the in-flight chunk (or the
// wait before a retry) and the session is discarded server-side; a cancel is never retried.
// Deliberately does NOT import @innobox/shared — this runs in the browser bundle, and the slicing
// math is trivial.

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

/** Attempts per part, in all (§11 *Failure*). */
export const PART_MAX_ATTEMPTS = 3;
/** The wait before the 2nd and the 3rd attempt of a part. */
export const PART_RETRY_DELAYS_MS: readonly number[] = [1000, 2000];

/** True for a part response worth retrying: a 5xx or a 429. Any other failing status is final. */
export function isRetryablePartStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Wait `ms`, rejecting with the cancellation error as soon as `signal` fires. */
function waitCancellable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(uploadCancelledError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(uploadCancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface ChunkedUploadOptions {
  /** The wait between part attempts — injectable so tests need not sleep. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** PUT one part, retrying a network error / 5xx / 429 up to PART_MAX_ATTEMPTS in all. Throws the
 *  last failure once out of attempts, a non-retryable failure at once, and the cancellation
 *  error (never retried) when `signal` fires. */
async function sendPart(
  url: string,
  body: Blob,
  signal: AbortSignal | undefined,
  wait: NonNullable<ChunkedUploadOptions["wait"]>,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    if (signal?.aborted) throw uploadCancelledError();
    let res: Response;
    try {
      res = await fetch(url, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body, signal });
    } catch (err) {
      // A cancellation is final; anything else fetch throws is a network error, so retryable.
      if (isAbortError(err) || signal?.aborted || attempt >= PART_MAX_ATTEMPTS) throw err;
      await wait(PART_RETRY_DELAYS_MS[attempt - 1]!, signal);
      continue;
    }
    if (res.ok) return;
    const failure = new Error(await readError(res, "A chunk failed to upload"));
    if (!isRetryablePartStatus(res.status) || attempt >= PART_MAX_ATTEMPTS) throw failure;
    await wait(PART_RETRY_DELAYS_MS[attempt - 1]!, signal);
  }
}

/** Upload `file` in chunks and return the created attachment view. `onProgress` is called with
 *  cumulative bytes uploaded after each part (0 → file.size). A part that fails transiently is
 *  retried (see `sendPart`); throws once a part is out of attempts (session aborted). When
 *  `signal` fires, the in-flight chunk (or a retry wait) is cancelled, the session is aborted
 *  through the abort endpoint, and an AbortError is thrown (see `isAbortError`). Initiate and
 *  complete are short and run unsignalled, so the session id is always known and a finished
 *  upload is never left half-committed — a cancel that lands during `complete` is the caller's to
 *  undo. */
export async function uploadFileInChunks(
  file: File,
  target: ChunkedUploadTarget,
  onProgress: (uploadedBytes: number, totalBytes: number) => void,
  signal?: AbortSignal,
  options: ChunkedUploadOptions = {},
): Promise<{ attachment: unknown }> {
  const wait = options.wait ?? waitCancellable;
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
      await sendPart(`/api/attachments/uploads/${uploadId}/parts/${partNumber}`, file.slice(start, end), signal, wait);
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

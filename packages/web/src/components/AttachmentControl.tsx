"use client";
// The one §11 upload control (INNOBOX_SPEC.md §11 "UI"), used identically on all three surfaces:
// the §6.1 challenge form and the §6.2 solution form (STAGED — files upload before the parent
// exists, keyed by the form's `draftKey`, and the create request binds them), and the §13.1
// detail-page author-edit section (BOUND — files attach straight to the existing item).
//
// Each file moves through two visually distinct phases: Uploading — a progress bar for a chunked
// file (> one chunk) or a spinner for a single-shot one — then Scanning… until the verdict, then
// Ready / Failed scan / Couldn't be scanned. The control polls while anything is scanning, so a
// row flips on its own. A file may be removed at ANY phase: while it is still uploading, Cancel
// stops the in-flight request and (for a chunked file) discards the session through the abort
// endpoint; once it has landed, Remove tombstones the stored row. On the submission forms `onBusyChange`
// drives the Submit gate (blocksSubmit). Bytes are only ever downloadable through the gateway,
// and only for a bound, clean file — a staged row is never served, so its name is plain text.
//
// Drop and paste (§11): files arrive from the picker (multiple), a page-wide drop, or a paste
// (routed by <AttachmentDropZone>). Each batch is pre-checked (type, size, per-item cap, folders);
// what passes joins this control's queue and uploads one file at a time, in order; the rest are
// named in one "Skipped: …" message. A Queued file is removable and gates Submit like an
// Uploading one; a failed or cancelled upload never stops the queue.
import { useCallback, useEffect, useRef, useState } from "react";
import { readJson } from "@/lib/api-client";
import { isAbortError, uploadFileInChunks } from "@/lib/chunked-upload";
import {
  attachmentPhaseClass,
  attachmentPhaseLabel,
  blocksSubmit,
  formatBytes,
  needsScanPoll,
  uploadMode,
  type AttachmentScanStatus,
} from "@/lib/attachment-control";
import { ATTACHMENT_ACCEPT, intakeAnnouncement, precheckFiles, skippedMessage } from "@/lib/attachment-intake";
import { reportFeatureUse } from "@/lib/survey-client";
import { useAttachmentDropTarget, type IntakeFile } from "./AttachmentDropZone";

export interface AttachmentControlItem {
  id: string;
  filename: string;
  sizeBytes: number;
  status: AttachmentScanStatus;
  /** The viewer uploaded it — only the uploader sees its phase and may remove it. */
  isUploader: boolean;
}

/** STAGED: a submission form's files, listed by draftKey. BOUND: an existing item's files, as the
 *  detail payload carries them; `canUpload` is the author-edit window, `onChanged` re-reads. */
export type AttachmentTarget =
  | { kind: "staged"; draftKey: string }
  | { kind: "bound"; parentId: string; attachments: AttachmentControlItem[]; canUpload: boolean; onChanged: () => unknown };

interface UploadConfig {
  chunkSizeBytes: number;
  maxUploadSizeMb: number;
  maxPerItem: number;
  scanEnforced: boolean;
}

interface QueuedFile {
  key: number;
  file: File;
}

interface ActiveUpload {
  filename: string;
  sizeBytes: number;
  mode: "chunked" | "single";
  progress: number; // 0..1
}

const DEFAULT_CHUNK_BYTES = 5 * 1024 * 1024;
const POLL_MS = 4000;

const LABEL: React.CSSProperties = {
  display: "block",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--faint)",
  marginBottom: 6,
};

const ROW: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" };

/** A thin determinate progress bar (0..1). */
function ProgressBar({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Upload progress"
      style={{ display: "inline-block", width: 120, height: 6, borderRadius: 3, background: "var(--line)", overflow: "hidden" }}
    >
      <span style={{ display: "block", height: "100%", width: `${pct}%`, background: "var(--accent)", transition: "width 120ms linear" }} />
    </span>
  );
}

export function AttachmentControl({
  parentType,
  target,
  disabled = false,
  onBusyChange,
  dropLabel,
}: {
  parentType: "challenge" | "solution";
  target: AttachmentTarget;
  /** The control's name on the page-wide drop overlay (e.g. "Your solution SOL-0031"). */
  dropLabel: string;
  /** Freezes the control (e.g. the §6.4 submission lock). */
  disabled?: boolean;
  /** Submission forms: true while Submit must stay disabled (see blocksSubmit). */
  onBusyChange?: (busy: boolean) => void;
}) {
  const staged = target.kind === "staged";
  const draftKey = target.kind === "staged" ? target.draftKey : null;
  const [stagedItems, setStagedItems] = useState<AttachmentControlItem[]>([]);
  const [config, setConfig] = useState<UploadConfig | null>(null);
  const [active, setActive] = useState<ActiveUpload | null>(null);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const queueKey = useRef(0);

  // Keep the latest bound re-read callback without re-arming effects on every parent render.
  const boundOnChanged = useRef<() => unknown>(() => {});
  useEffect(() => {
    boundOnChanged.current = target.kind === "bound" ? target.onChanged : () => {};
  });

  const items: AttachmentControlItem[] = target.kind === "staged" ? stagedItems : target.attachments;
  const canUpload = target.kind === "staged" ? true : target.canUpload;

  const refresh = useCallback(async () => {
    if (draftKey === null) {
      await boundOnChanged.current();
      return;
    }
    try {
      const res = await fetch(`/api/attachments?draftKey=${encodeURIComponent(draftKey)}`, { headers: { accept: "application/json" } });
      const json = await readJson(res);
      if (res.ok) setStagedItems((json.attachments as AttachmentControlItem[]) ?? []);
    } catch {
      /* transient — the next poll / interaction retries */
    }
  }, [draftKey]);

  useEffect(() => {
    if (draftKey !== null) void refresh();
  }, [draftKey, refresh]);

  useEffect(() => {
    if (!canUpload) return;
    fetch("/api/attachments/config", { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j) setConfig({ chunkSizeBytes: j.chunkSizeMb * 1024 * 1024, maxUploadSizeMb: j.maxUploadSizeMb, maxPerItem: j.maxPerItem, scanEnforced: j.scanEnforced });
      })
      .catch(() => {});
  }, [canUpload]);

  // Leaving the surface mid-upload (a form closed, the page left) cancels it — the chunked
  // session is aborted rather than left for the GC.
  useEffect(() => () => controllerRef.current?.abort(), []);

  // Poll while one of the viewer's own files is still scanning.
  const ownStatuses = items.filter((a) => a.isUploader).map((a) => a.status);
  const polling = needsScanPoll(ownStatuses);
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [polling, refresh]);

  // A Queued file gates Submit exactly as an Uploading one does.
  const uploading = active !== null || queue.length > 0;
  const busy = blocksSubmit({ uploading, scanEnforced: config?.scanEnforced ?? false, statuses: ownStatuses });
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  const removeStored = async (id: string): Promise<void> => {
    const res = await fetch(`/api/attachments/${id}`, { method: "DELETE" });
    const json = await readJson(res);
    if (!res.ok) throw new Error(json.error ?? "Could not remove attachment");
  };

  const upload = async (file: File) => {
    const mode = uploadMode(file.size, config?.chunkSizeBytes ?? DEFAULT_CHUNK_BYTES);
    const where = target.kind === "staged" ? { draftKey: target.draftKey } : { parentId: target.parentId };
    const controller = new AbortController();
    controllerRef.current = controller;
    setActive({ filename: file.name, sizeBytes: file.size, mode, progress: 0 });
    try {
      let createdId: string | undefined;
      if (mode === "chunked") {
        const out = await uploadFileInChunks(
          file,
          { parentType, ...where },
          (up, total) => setActive((a) => (a ? { ...a, progress: total ? up / total : 0 } : a)),
          controller.signal,
        );
        createdId = (out.attachment as { id?: string } | null)?.id;
      } else {
        const form = new FormData();
        form.append("parentType", parentType);
        if (where.draftKey) form.append("draftKey", where.draftKey);
        if (where.parentId) form.append("parentId", where.parentId);
        form.append("file", file);
        const res = await fetch("/api/attachments", { method: "POST", body: form, signal: controller.signal });
        const json = await readJson(res);
        if (!res.ok) throw new Error(json.error ?? "Could not upload attachment");
        createdId = (json.attachment as { id?: string } | undefined)?.id;
      }
      // Removed while the final request was landing: the row now exists, so tombstone it.
      if (controller.signal.aborted && createdId) await removeStored(createdId);
      else if (createdId) reportFeatureUse("attachments"); // §13.10: a completed upload
    } catch (err) {
      if (!isAbortError(err)) setError(`${file.name}: ${err instanceof Error ? err.message : "Could not upload attachment"}`);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setActive(null);
      // A cancelled single-shot request may still have landed — the re-read shows it, removable.
      await refresh();
    }
  };

  // The queue runner: the next file starts once nothing is in flight. `upload` sets `active`
  // synchronously before its first await, so the re-run sees it and never starts two at once.
  const uploadRef = useRef(upload);
  useEffect(() => {
    uploadRef.current = upload;
  });
  useEffect(() => {
    if (active !== null || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void uploadRef.current(next!.file);
  }, [active, queue]);

  const enabled = canUpload && !disabled;

  /** One batch from the picker, a drop or a paste: pre-check, queue what passes, name the rest. */
  const enqueue = (files: IntakeFile[]) => {
    if (!enabled || files.length === 0) return;
    const { accepted, skipped: refused } = precheckFiles(
      files.map((f) => ({ name: f.file.name, size: f.file.size, isDirectory: f.isDirectory, file: f.file })),
      {
        maxUploadSizeMb: config?.maxUploadSizeMb ?? null,
        maxPerItem: config?.maxPerItem ?? null,
        taken: items.length + queue.length + (active ? 1 : 0),
      },
    );
    setError(null);
    setSkipped(skippedMessage(refused));
    setAnnouncement(intakeAnnouncement(accepted.length, refused.length));
    if (accepted.length > 0) setQueue((q) => [...q, ...accepted.map((a) => ({ key: ++queueKey.current, file: a.file }))]);
  };

  const hasDropZone = useAttachmentDropTarget(rootRef, { label: dropLabel, enabled, accept: enqueue });

  const cancelUpload = () => controllerRef.current?.abort();
  const unqueue = (key: number) => setQueue((q) => q.filter((f) => f.key !== key));

  const remove = async (id: string) => {
    setError(null);
    try {
      await removeStored(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove attachment");
    }
    await refresh();
  };

  // A read-only bound item with nothing attached renders nothing at all.
  if (!canUpload && items.length === 0) return null;

  return (
    <div className="attachment-control" ref={rootRef}>
      <label style={LABEL}>Attachments</label>
      {items.length === 0 && !active && !staged && (
        <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>
          No attachments yet.
        </p>
      )}
      {(items.length > 0 || active || queue.length > 0) && (
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 8px", display: "flex", flexDirection: "column", gap: 6 }}>
          {items.map((a) => {
            const downloadable = !staged && a.status === "clean";
            // The phase is the uploader's business; Ready is only worth saying while editable.
            const showPhase = a.isUploader && (canUpload || a.status !== "clean");
            const removable = canUpload && a.isUploader;
            return (
              <li key={a.id} style={ROW}>
                {downloadable ? (
                  <a href={`/api/attachments/${a.id}`} style={{ color: "var(--accent)", textDecoration: "underline", fontSize: 14 }}>
                    {a.filename}
                  </a>
                ) : (
                  <span style={{ fontSize: 14 }}>{a.filename}</span>
                )}
                <span className="mono muted" style={{ fontSize: 12 }}>
                  {formatBytes(a.sizeBytes)}
                </span>
                {showPhase && (
                  <span className={attachmentPhaseClass(a.status)} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {a.status === "pending" && <span className="spinner" aria-hidden="true" />}
                    {attachmentPhaseLabel(a.status)}
                  </span>
                )}
                {removable && (
                  <button type="button" className="btn btn-sm btn-danger" disabled={disabled} onClick={() => remove(a.id)}>
                    Remove
                  </button>
                )}
              </li>
            );
          })}
          {active && (
            <li style={ROW} aria-live="polite">
              <span style={{ fontSize: 14 }}>{active.filename}</span>
              <span className="mono muted" style={{ fontSize: 12 }}>
                {formatBytes(active.sizeBytes)}
              </span>
              {active.mode === "chunked" ? (
                <>
                  <ProgressBar value={active.progress} />
                  <span className="mono muted" style={{ fontSize: 12 }}>
                    Uploading… {Math.round(active.progress * 100)}%
                  </span>
                </>
              ) : (
                <span className="chip" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span className="spinner" aria-hidden="true" />
                  Uploading…
                </span>
              )}
              <button type="button" className="btn btn-sm btn-danger" disabled={disabled} onClick={cancelUpload}>
                Cancel
              </button>
            </li>
          )}
          {queue.map((q) => (
            <li key={`queued-${q.key}`} style={ROW}>
              <span style={{ fontSize: 14 }}>{q.file.name}</span>
              <span className="mono muted" style={{ fontSize: 12 }}>
                {formatBytes(q.file.size)}
              </span>
              <span className="chip">Queued</span>
              <button type="button" className="btn btn-sm btn-danger" disabled={disabled} onClick={() => unqueue(q.key)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {canUpload && (
        <>
          <div style={ROW}>
            <input
              ref={fileRef}
              type="file"
              className="field"
              style={{ maxWidth: 340 }}
              disabled={disabled}
              multiple
              accept={ATTACHMENT_ACCEPT}
              aria-label="Attach files"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                e.target.value = "";
                enqueue(picked.map((file) => ({ file, isDirectory: false })));
              }}
            />
          </div>
          <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
            {hasDropZone && "You can also drop files anywhere on the page, or paste them. "}
            {staged
              ? config?.scanEnforced
                ? "Each file is virus-scanned; you can submit once every file is Ready."
                : "Files are attached when you submit."
              : "Each file is virus-scanned and can be downloaded once it is Ready."}
          </p>
        </>
      )}
      {skipped && (
        <p className="muted" data-testid="attachment-skipped" style={{ color: "var(--warn)", fontSize: 13, margin: "6px 0 0", overflowWrap: "anywhere" }}>
          {skipped}
        </p>
      )}
      {error && (
        <p className="muted" role="alert" style={{ color: "var(--danger)", fontSize: 13, margin: "6px 0 0" }}>
          {error}
        </p>
      )}
      <span className="form-lock-status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}

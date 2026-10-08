"use client";
// §11 staged attachments for the submission forms (challenge §6.1 / solution §6.2). Files are
// uploaded BEFORE the parent exists, keyed by a client-generated `draftKey`; on submit the parent
// form posts that same draftKey and the API binds these rows to the new item. Each file moves
// through two distinct phases — Uploading (a progress bar for a chunked file > the chunk size, a
// spinner for a single-shot file) then Scanning… → Ready / Failed scan / Couldn't be scanned (the
// last two removable, so the author can drop the file and try another). While a scanner is
// available the parent form's Submit stays disabled until every file is Ready (via `onBusyChange`);
// when unavailable the platform fails open. Bytes are never served for a staged row, so filenames
// are plain text (no download link).
import { useCallback, useEffect, useRef, useState } from "react";
import { readJson } from "@/lib/api-client";
import { uploadFileInChunks } from "@/lib/chunked-upload";

export interface StagedAttachmentItem {
  id: string;
  filename: string;
  sizeBytes: number;
  status: "pending" | "clean" | "infected" | "unscannable";
  isUploader: boolean;
  createdAt: string;
}

interface UploadConfig {
  chunkSizeBytes: number;
  maxUploadSizeMb: number;
  scanEnforced: boolean;
}

interface ActiveUpload {
  filename: string;
  sizeBytes: number;
  mode: "chunked" | "single";
  progress: number; // 0..1
}

// Client-side mirror of the §11 allowlist for the file-input hint (the server is authoritative).
const ATTACHMENT_ACCEPT = ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.rtf,.txt,.csv,.md,.png,.jpg,.jpeg,.gif,.webp,.zip";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const LABEL: React.CSSProperties = {
  display: "block",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--faint)",
  marginBottom: 6,
};

/** A thin determinate progress bar (0..1). */
function ProgressBar({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{ display: "inline-block", width: 120, height: 6, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}
    >
      <span style={{ display: "block", height: "100%", width: `${pct}%`, background: "var(--accent)", transition: "width 120ms linear" }} />
    </span>
  );
}

/** A staged-upload control bound to a form's `draftKey`. Generate the key once in the parent
 *  (`useState(() => crypto.randomUUID())`) and include it in the create request body on submit.
 *  `onBusyChange` tells the parent when to disable Submit (a file is uploading, or — while a
 *  scanner is available — still scanning or failed). */
export function StagedAttachments({
  parentType,
  draftKey,
  disabled = false,
  onBusyChange,
}: {
  parentType: "challenge" | "solution";
  draftKey: string;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [items, setItems] = useState<StagedAttachmentItem[]>([]);
  const [config, setConfig] = useState<UploadConfig | null>(null);
  const [active, setActive] = useState<ActiveUpload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/attachments?draftKey=${encodeURIComponent(draftKey)}`, { headers: { accept: "application/json" } });
      const json = await readJson(res);
      if (res.ok) setItems((json.attachments as StagedAttachmentItem[]) ?? []);
    } catch {
      /* transient — the next poll / interaction retries */
    }
  }, [draftKey]);

  useEffect(() => {
    void refresh();
    fetch("/api/attachments/config", { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j) setConfig({ chunkSizeBytes: j.chunkSizeMb * 1024 * 1024, maxUploadSizeMb: j.maxUploadSizeMb, scanEnforced: j.scanEnforced });
      })
      .catch(() => {});
  }, [refresh]);

  // Poll while anything is still scanning so the row flips to Ready / Failed on its own.
  const hasPending = items.some((a) => a.status === "pending");
  useEffect(() => {
    if (!hasPending) return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [hasPending, refresh]);

  // Tell the parent when Submit must stay disabled: a file is uploading, or — when scanning is
  // enforced — any file is still scanning, failed its scan, or couldn't be scanned (§11 scan
  // gate). Fails open when unavailable.
  const scanEnforced = config?.scanEnforced ?? false;
  const busy = active !== null || (scanEnforced && items.some((a) => a.status !== "clean"));
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  const upload = async (file: File) => {
    setError(null);
    const chunkSizeBytes = config?.chunkSizeBytes ?? 5 * 1024 * 1024;
    if (config && file.size > config.maxUploadSizeMb * 1024 * 1024) {
      setError(`That file exceeds the ${config.maxUploadSizeMb} MB limit.`);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    const chunked = file.size > chunkSizeBytes;
    setActive({ filename: file.name, sizeBytes: file.size, mode: chunked ? "chunked" : "single", progress: 0 });
    try {
      if (chunked) {
        await uploadFileInChunks(file, { parentType, draftKey }, (up, total) =>
          setActive((a) => (a ? { ...a, progress: total ? up / total : 0 } : a)),
        );
      } else {
        const form = new FormData();
        form.append("parentType", parentType);
        form.append("draftKey", draftKey);
        form.append("file", file);
        const res = await fetch("/api/attachments", { method: "POST", body: form });
        const json = await readJson(res);
        if (!res.ok) throw new Error(json.error ?? "Could not upload attachment");
      }
      if (fileRef.current) fileRef.current.value = "";
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload attachment");
    } finally {
      setActive(null);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/attachments/${id}`, { method: "DELETE" });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not remove attachment");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove attachment");
    }
  };

  const uploading = active !== null;

  return (
    <div>
      <label style={LABEL}>Attachments</label>
      {(items.length > 0 || active) && (
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 8px", display: "flex", flexDirection: "column", gap: 6 }}>
          {items.map((a) => (
            <li key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 14 }}>{a.filename}</span>
              <span className="mono muted" style={{ fontSize: 12 }}>
                {formatBytes(a.sizeBytes)}
              </span>
              {a.status === "pending" && <span className="chip">Scanning…</span>}
              {a.status === "clean" && <span className="pill pill-ok">Ready</span>}
              {a.status === "infected" && <span className="pill pill-danger">Failed scan</span>}
              {a.status === "unscannable" && <span className="pill pill-danger">Couldn&apos;t be scanned</span>}
              <button type="button" className="btn btn-sm btn-danger" disabled={disabled || uploading} onClick={() => remove(a.id)}>
                Remove
              </button>
            </li>
          ))}
          {active && (
            <li style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
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
                <span className="chip">Uploading…</span>
              )}
            </li>
          )}
        </ul>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          ref={fileRef}
          type="file"
          className="field"
          style={{ maxWidth: 340 }}
          disabled={disabled || uploading}
          accept={ATTACHMENT_ACCEPT}
          aria-label="Attach a file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
        {scanEnforced
          ? "Each file is virus-scanned; you can submit once every file is Ready."
          : "Files are attached when you submit."}
      </p>
      {error && (
        <p className="muted" style={{ color: "var(--danger)", fontSize: 13, margin: "6px 0 0" }}>
          {error}
        </p>
      )}
    </div>
  );
}

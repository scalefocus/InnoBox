"use client";
// Mark as duplicate on the challenge detail page (INNOBOX_SPEC.md §42.3, §42.5):
//   - MarkDuplicateButton — beside the status control while the payload says `canMarkDuplicate`. It
//     opens MarkDuplicateDialog, a native modal <dialog> (showModal gives the focus trap, Escape and
//     the inert page behind it): a search over eligible originals only (the server filters; before
//     anything is typed it lists the similar ones), an optional note with a live counter, and the
//     "What happens" preview read for the picked original. A refused pick shows its message inline
//     and disables the button. The primary button locks while the request is in flight (§6.4).
//   - DuplicateBanner — on a duplicate: the original (number and title, linked) and the note only for
//     a viewer who can see it, otherwise "Closed as a duplicate." with nothing more; the authors' line.
//   - AlsoRaisedAs — on an original: the duplicates the viewer can see.
// Nothing here names an author (§42.5 anonymity); the server re-checks everything.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  DUPLICATE_NOTE_MAX,
  alsoRaisedAsPrefix,
  duplicateAuthorHint,
  duplicateBannerText,
  duplicateMarkedToast,
  duplicatePreviewLines,
  type DuplicatePreview,
} from "@innobox/shared/duplicates";
import { PrimaryButtonLabel, useFormLock } from "@/components/FormLock";
import { primaryButtonState } from "@/lib/form-lock";
import { readJson } from "@/lib/api-client";
import { CHALLENGE_STATUS_LABEL, statusPillClass } from "@/app/challenges/status";

/** A challenge a duplicate pointer names — number ("CH-12") and title, never an author. */
export interface DuplicateRef {
  number: string;
  title: string;
}

interface Candidate extends DuplicateRef {
  status: string;
  namespace: string;
}

type PreviewState = { ok: true; original: string } & DuplicatePreview;

const digits = (n: string) => n.replace(/\D/g, "");

/** The Mark as duplicate button and its dialog. `challengeNumber` is "CH-30". `openWith` — the
 *  triage notes' shortcut — opens the dialog with that original already picked (each request bumps
 *  `openRequest`). */
export function MarkDuplicateButton({
  challengeNumber,
  busy,
  openRequest = 0,
  openWith = null,
  onMarked,
}: {
  challengeNumber: string;
  busy: boolean;
  openRequest?: number;
  openWith?: string | null;
  /** Called with the toast once the dialog has closed after a successful mark. */
  onMarked: (toast: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<string | null>(null);
  // A new request from the triage notes opens the dialog with its original — adjusted while
  // rendering (React's "state from a changed prop" pattern), not in an effect.
  const [seenRequest, setSeenRequest] = useState(openRequest);
  if (openRequest !== seenRequest) {
    setSeenRequest(openRequest);
    if (openRequest > 0) {
      setPreset(openWith);
      setOpen(true);
    }
  }
  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy}
        data-testid="mark-duplicate"
        onClick={() => {
          setPreset(null);
          setOpen(true);
        }}
      >
        Mark as duplicate
      </button>
      {open && <MarkDuplicateDialog challengeNumber={challengeNumber} preset={preset} onMarked={onMarked} onClose={() => setOpen(false)} />}
    </>
  );
}

function MarkDuplicateDialog({
  challengeNumber,
  preset,
  onMarked,
  onClose,
}: {
  challengeNumber: string;
  preset: string | null;
  onMarked: (toast: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [similar, setSimilar] = useState(true);
  const [picked, setPicked] = useState<string | null>(preset);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const lock = useFormLock();
  const base = `/api/challenges/${digits(challengeNumber)}/duplicate`;

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // The search: the similar ones while empty, otherwise matches — eligible originals only.
  useEffect(() => {
    let cancelled = false;
    const q = query.trim();
    const timer = window.setTimeout(
      async () => {
        try {
          const res = await fetch(`${base}/candidates?q=${encodeURIComponent(q)}`);
          const json = await readJson(res);
          if (cancelled) return;
          if (!res.ok) throw new Error(json.error ?? "Could not search challenges");
          setCandidates((json.candidates as Candidate[]) ?? []);
          setSimilar(json.similar === true);
        } catch (err) {
          if (!cancelled) setError(err instanceof Error ? err.message : "Could not search challenges");
        }
      },
      q === "" ? 0 : 250,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, base]);

  // The preview for the picked original — what the mark would do, or why it can't. A new pick
  // clears the previous answer in its click handler (`pick`), so nothing stale shows meanwhile.
  useEffect(() => {
    if (!picked) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${base}/preview?original=${encodeURIComponent(digits(picked))}`);
        const json = await readJson(res);
        if (cancelled) return;
        if (!res.ok) throw new Error(json.error ?? "Could not check that challenge");
        if (json.ok === true) {
          setPreview(json as unknown as PreviewState);
          setRefusal(null);
        } else {
          setPreview(null);
          setRefusal(typeof json.message === "string" ? json.message : "That challenge can't be the original.");
        }
      } catch (err) {
        if (!cancelled) {
          setPreview(null);
          setRefusal(err instanceof Error ? err.message : "Could not check that challenge");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [picked, base]);

  const pick = (number: string) => {
    if (number === picked) return;
    setPreview(null);
    setRefusal(null);
    setPicked(number);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!picked || !preview || !lock.lock()) return;
    setError(null);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ original: picked, note: note.trim() === "" ? null : note }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "The challenge wasn't marked. Try again.");
      lock.succeed();
      ref.current?.close();
      await onMarked(duplicateMarkedToast(challengeNumber, picked));
    } catch (err) {
      lock.release();
      setError(err instanceof Error ? err.message : "The challenge wasn't marked. Try again.");
    }
  };

  const button = primaryButtonState({ locked: lock.locked, idleLabel: "Mark as duplicate" });
  const lines = preview ? duplicatePreviewLines(challengeNumber, preview.original, preview) : [];
  const pickedListed = picked !== null && candidates.some((c) => c.number === picked);

  return (
    <dialog
      ref={ref}
      className="author-reveal-dialog propose-dialog"
      aria-labelledby="duplicate-title"
      data-testid="duplicate-dialog"
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === ref.current && !lock.locked) ref.current?.close();
      }}
    >
      <form className="propose-body" onSubmit={submit}>
        <h2 id="duplicate-title" className="propose-title">
          Mark {challengeNumber} as a duplicate
        </h2>
        <p className="muted propose-sub">
          It closes, its followers follow the original instead, and its author is told where the discussion continues.
        </p>
        <div className="form-lock-host" aria-busy={lock.locked}>
          <label className="propose-label" htmlFor="duplicate-original">
            Original
          </label>
          <div inert={lock.locked}>
            <input
              id="duplicate-original"
              className="field"
              style={{ width: "100%" }}
              autoFocus
              placeholder="Search by number or title…"
              value={query}
              data-testid="duplicate-search"
              onChange={(e) => setQuery(e.target.value)}
            />
            {picked && !pickedListed && (
              <p className="sub" style={{ margin: "6px 0 0" }}>
                Picked: <strong>{picked}</strong>
              </p>
            )}
            <p className="sub mono" style={{ margin: "10px 0 0", letterSpacing: "0.06em", textTransform: "uppercase", fontSize: 11 }}>
              {similar ? "Similar challenges" : "Matching challenges"}
            </p>
            {candidates.length === 0 ? (
              <p className="muted" style={{ margin: "6px 0 0", fontSize: 13.5 }}>
                {similar ? "Nothing similar found — search by number or title." : "No challenge you can choose matches."}
              </p>
            ) : (
              <ul className="duplicate-candidates" aria-label="Possible originals">
                {candidates.map((c) => (
                  <li key={c.number}>
                    <button
                      type="button"
                      className="duplicate-candidate"
                      aria-pressed={picked === c.number}
                      data-testid="duplicate-candidate"
                      onClick={() => pick(c.number)}
                    >
                      <span className="mono" style={{ fontSize: 12.5 }}>
                        {c.number}
                      </span>
                      <span className="duplicate-candidate-title" title={c.title}>
                        {c.title}
                      </span>
                      <span className={statusPillClass(c.status)}>{CHALLENGE_STATUS_LABEL[c.status] ?? c.status}</span>
                      <span className="duplicate-candidate-ns">/{c.namespace}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <label className="propose-label invite-note-label" htmlFor="duplicate-note">
            Note
          </label>
          <textarea
            id="duplicate-note"
            className="field invite-note"
            rows={3}
            value={note}
            maxLength={DUPLICATE_NOTE_MAX}
            placeholder="Why is this a duplicate? (optional)"
            inert={lock.locked}
            data-testid="duplicate-note"
            onChange={(e) => setNote(e.target.value.slice(0, DUPLICATE_NOTE_MAX))}
          />
          <div className="propose-counter sub mono" aria-live="polite">
            Shown on this challenge and in the author&apos;s notification. Your name isn&apos;t. {note.length} / {DUPLICATE_NOTE_MAX}
          </div>
          {lines.length > 0 && (
            <div data-testid="duplicate-preview">
              <span className="propose-label">What happens</span>
              <ul className="duplicate-preview">
                {lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {(refusal || error) && (
          <p className="tag-error" role="alert" data-testid="duplicate-refusal">
            {refusal ?? error}
          </p>
        )}
        <div className="propose-actions">
          <button type="button" className="btn btn-sm btn-ghost" disabled={lock.locked} onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={button.disabled || !preview} data-testid="duplicate-confirm">
            <PrimaryButtonLabel state={button} />
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** §42.5: the banner on a duplicate. `original` is null when the viewer cannot see it (or it was
 *  deleted) — then no number, title or note. `isAuthor` adds the authors' line. */
export function DuplicateBanner({ original, note, isAuthor }: { original: DuplicateRef | null; note: string | null; isAuthor: boolean }) {
  return (
    <section className="duplicate-banner" aria-label="Closed as a duplicate" data-testid="duplicate-banner">
      <p className="duplicate-banner-title">
        {original ? (
          <>
            Closed as a duplicate of{" "}
            <Link href={`/challenges/${digits(original.number)}`} data-testid="duplicate-original-link">
              {original.number} — {original.title}
            </Link>
          </>
        ) : (
          duplicateBannerText(null)
        )}
      </p>
      {original && note && <p className="duplicate-banner-note">&ldquo;{note}&rdquo;</p>}
      {isAuthor && <p className="duplicate-banner-hint">{duplicateAuthorHint(original)}</p>}
    </section>
  );
}

/** §42.5: the original's "Also raised as CH-30, CH-31" — only the duplicates the viewer can see. */
export function AlsoRaisedAs({ duplicates }: { duplicates: readonly DuplicateRef[] }) {
  if (duplicates.length === 0) return null;
  return (
    <p className="also-raised" data-testid="also-raised-as">
      {alsoRaisedAsPrefix()}{" "}
      {duplicates.map((d, i) => (
        <span key={d.number}>
          {i > 0 && ", "}
          <Link href={`/challenges/${digits(d.number)}`} title={d.title}>
            {d.number}
          </Link>
        </span>
      ))}
    </p>
  );
}

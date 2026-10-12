"use client";
// "Improve with AI" (INNOBOX_SPEC.md §22.10) — the button, its confirm-before-replace dialog, the
// in-flight state with Cancel, the single-step Undo and (challenge form) the impact-area hint.
// Shown only when AI is available for this task (no disabled ghost); a namespace-only challenge
// disables it with an explanation while restricted content may not be sent.
//
// Flow: clicked, never automatic. When a target field already holds text a dialog offers
// Replace · Fill empty fields only · Cancel before anything is sent. While drafting the target
// fields are read-only (the parent reads `busy`). Undo restores the pre-draft text and goes away
// on the next draft, on submit (`noteSubmit`) or as soon as a drafted field is edited
// (`noteEdit`). The draft is plain text the author owns: nothing marks it as AI-written.
import { useCallback, useEffect, useRef, useState } from "react";
import { readJson } from "@/lib/api-client";

export type DraftKind = "challenge" | "solution";

/** A target field: its current value and its setter. */
export type DraftFieldBinding = readonly [value: string, set: (v: string) => void];

interface ImpactAreaHint {
  id: string;
  name: string;
}

export interface ImproveWithAiOptions {
  kind: DraftKind;
  /** The fields a draft may fill, keyed by the draft's own key (title/description/costVsBenefits). */
  fields: Record<string, DraftFieldBinding>;
  /** The POST body (kind-specific, egress fields only). */
  body: () => Record<string, unknown>;
  /** Whether the text is namespace-only (restricted content). */
  restricted: boolean;
}

export interface ImproveWithAiState {
  available: boolean;
  displayName: string;
  busy: boolean;
  disabledReason: string | null;
  /** Every target field is blank — the button waits for some text. */
  empty: boolean;
  confirmOpen: boolean;
  canUndo: boolean;
  error: string | null;
  hint: ImpactAreaHint | null;
  start: () => void;
  confirm: (mode: "replace" | "empty") => void;
  closeConfirm: () => void;
  cancel: () => void;
  undo: () => void;
  dismissHint: () => void;
  /** Call from a target field's onChange: editing a drafted field retires Undo. */
  noteEdit: (key: string) => void;
  /** Call on submit: Undo goes away. */
  noteSubmit: () => void;
}

const RESTRICTED_REASON = "Not available for challenges visible only to their namespace.";

export function useImproveWithAi(opts: ImproveWithAiOptions): ImproveWithAiState {
  const [availability, setAvailability] = useState<{ available: boolean; restrictedAllowed: boolean; displayName: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<ImpactAreaHint | null>(null);
  // The pre-draft snapshot and which fields the draft actually wrote.
  const [undoState, setUndoState] = useState<{ before: Record<string, string>; drafted: string[] } | null>(null);
  const abort = useRef<AbortController | null>(null);
  // The latest options for the event handlers (they run after commit, so after this effect).
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  useEffect(() => {
    let live = true;
    fetch("/api/ai/draft", { headers: { accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (live && json) setAvailability({ available: !!json.available, restrictedAllowed: !!json.restrictedAllowed, displayName: String(json.displayName ?? "AI") });
      })
      .catch(() => {});
    return () => {
      live = false;
      abort.current?.abort();
    };
  }, []);

  const run = useCallback(async (mode: "replace" | "empty") => {
    const { fields, body } = optsRef.current;
    const before: Record<string, string> = {};
    for (const [k, [v]] of Object.entries(fields)) before[k] = v;
    setUndoState(null);
    setHint(null);
    setError(null);
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const res = await fetch("/api/ai/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body()),
        signal: ctl.signal,
      });
      const json = await readJson(res);
      if (!res.ok || json.ok !== true) throw new Error(json.error ?? "Couldn't improve the text right now — try again later.");
      const draft = json.draft as Record<string, unknown>;
      const drafted: string[] = [];
      for (const [k, [current, set]] of Object.entries(optsRef.current.fields)) {
        const next = draft[k];
        if (typeof next !== "string" || next === "") continue;
        if (mode === "empty" && current.trim() !== "") continue;
        if (next === current) continue;
        set(next);
        drafted.push(k);
      }
      if (drafted.length > 0) setUndoState({ before, drafted });
      const area = draft.impactArea as ImpactAreaHint | null | undefined;
      if (area && typeof area.id === "string") setHint(area);
    } catch (err) {
      if (!ctl.signal.aborted) setError(err instanceof Error ? err.message : "Couldn't improve the text right now — try again later.");
    } finally {
      if (abort.current === ctl) abort.current = null;
      setBusy(false);
    }
  }, []);

  const restrictedBlocked = opts.restricted && !(availability?.restrictedAllowed ?? false);
  // There is nothing to improve until the author has written something.
  const empty = Object.values(opts.fields).every(([v]) => v.trim() === "");

  return {
    available: !!availability?.available,
    displayName: availability?.displayName ?? "AI",
    busy,
    disabledReason: restrictedBlocked ? RESTRICTED_REASON : null,
    empty,
    confirmOpen,
    canUndo: undoState !== null,
    error,
    hint,
    start: () => {
      if (busy) return;
      // Some text exists (the button is disabled otherwise): confirm before anything is sent.
      setConfirmOpen(true);
    },
    confirm: (mode) => {
      setConfirmOpen(false);
      void run(mode);
    },
    closeConfirm: () => setConfirmOpen(false),
    cancel: () => abort.current?.abort(),
    undo: () => {
      if (!undoState) return;
      for (const k of undoState.drafted) optsRef.current.fields[k]?.[1](undoState.before[k] ?? "");
      setUndoState(null);
    },
    dismissHint: () => setHint(null),
    noteEdit: (key) => {
      if (undoState?.drafted.includes(key)) setUndoState(null);
    },
    noteSubmit: () => setUndoState(null),
  };
}

/** The button row: Improve / Improving… + Cancel / Undo, the error, the confirm dialog and (for a
 *  challenge) the impact-area hint with Apply. Renders nothing while AI is unavailable. */
export function ImproveWithAiBar({ ai, onApplyHint, disabled = false }: { ai: ImproveWithAiState; onApplyHint?: (id: string) => void; disabled?: boolean }) {
  if (!ai.available) return null;
  return (
    <div className="ai-draft" data-testid="ai-draft">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {ai.busy ? (
          <>
            <span className="btn btn-sm" aria-live="polite" role="status">
              <span className="spinner" aria-hidden="true" /> Improving…
            </span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={ai.cancel}>
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled || ai.disabledReason !== null || ai.empty}
            title={ai.empty && !ai.disabledReason ? "Write something first" : undefined}
            aria-describedby={ai.disabledReason ? "ai-draft-reason" : undefined}
            onClick={ai.start}
          >
            ✨ Improve with {ai.displayName}
          </button>
        )}
        {ai.canUndo && !ai.busy && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={ai.undo}>
            Undo
          </button>
        )}
        {ai.disabledReason && (
          <span id="ai-draft-reason" className="muted" style={{ fontSize: 12.5 }}>
            {ai.disabledReason}
          </span>
        )}
      </div>
      {ai.error && (
        <p className="muted" role="alert" style={{ color: "var(--danger)", fontSize: 13, margin: "6px 0 0" }}>
          {ai.error}
        </p>
      )}
      {ai.hint && onApplyHint && (
        <p className="sub" style={{ margin: "8px 0 0", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }} data-testid="ai-draft-hint">
          Suggested impact area: <strong>{ai.hint.name}</strong>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              onApplyHint(ai.hint!.id);
              ai.dismissHint();
            }}
          >
            Apply
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={ai.dismissHint}>
            Dismiss
          </button>
        </p>
      )}
      {ai.confirmOpen && (
        <div role="dialog" aria-modal="false" aria-labelledby="ai-draft-confirm" className="ai-draft-confirm">
          <p id="ai-draft-confirm" style={{ margin: "0 0 10px", fontSize: 14 }}>
            Some fields already have text. What should {ai.displayName} do with them?
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => ai.confirm("replace")}>
              Replace
            </button>
            <button type="button" className="btn btn-sm" onClick={() => ai.confirm("empty")}>
              Fill empty fields only
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={ai.closeConfirm}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

"use client";
// "Propose a feature" (INNOBOX_SPEC.md §38.4): a native modal <dialog> — showModal gives the focus
// trap, Escape and the inert page behind it — with one required text box, a live counter, and the
// §6.4 submission lock on Send. Closing with text in the box asks first. The person's §38.6 name
// switch decides whether the sub-line promises their name. With MAX_PENDING_IDEAS proposals already
// waiting, the dialog says so and Send stays disabled; the server re-checks the cap either way.
import { useEffect, useRef, useState } from "react";
import { FEATURE_IDEA_MESSAGES, FEATURE_IDEA_TEXT_MAX } from "@innobox/shared/feature-ideas";
import { PrimaryButtonLabel, useFormLock } from "@/components/FormLock";
import { primaryButtonState } from "@/lib/form-lock";
import { readJson } from "@/lib/api-client";

/** How long the thank-you stays before the dialog closes itself. */
const THANKS_MS = 4000;

export function ProposeFeatureDialog({
  named,
  atCap,
  onSent,
  onClose,
}: {
  named: boolean;
  atCap: boolean;
  onSent: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const lock = useFormLock();
  const textRef = useRef(text);
  textRef.current = text;
  const sentRef = useRef(sent);
  sentRef.current = sent;

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    if (!sent) return;
    const timer = window.setTimeout(() => ref.current?.close(), THANKS_MS);
    return () => window.clearTimeout(timer);
  }, [sent]);

  /** True when it may close: nothing typed, already sent, or the person agreed to discard. */
  const mayClose = (): boolean => sentRef.current || textRef.current.trim() === "" || window.confirm("Discard your idea?");

  const tryClose = () => {
    if (mayClose()) ref.current?.close();
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (atCap || text.trim() === "" || !lock.lock()) return;
    setError(null);
    try {
      const res = await fetch("/api/feature-ideas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: text }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Your idea wasn't sent. Try again.");
      lock.succeed();
      setSent(true);
      onSent();
    } catch (err) {
      lock.release();
      setError(err instanceof Error ? err.message : "Your idea wasn't sent. Try again.");
    }
  };

  const button = primaryButtonState({ locked: lock.locked, idleLabel: "Send idea" });
  const sub = named
    ? "Describe what you'd like InnoBox to do and why. A platform admin reviews every idea. If it's planned, it appears here with your name."
    : "Describe what you'd like InnoBox to do and why. A platform admin reviews every idea. If it's planned, it appears here.";

  return (
    <dialog
      ref={ref}
      className="author-reveal-dialog propose-dialog"
      aria-labelledby="propose-title"
      data-testid="propose-dialog"
      onClose={onClose}
      onCancel={(e) => {
        // Escape: ask first when there is text to lose.
        if (!mayClose()) e.preventDefault();
      }}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === ref.current) tryClose();
      }}
    >
      <form className="propose-body" onSubmit={send}>
        <h2 id="propose-title" className="propose-title">
          Propose a feature
        </h2>
        {sent ? (
          <p className="propose-thanks" role="status">
            Thanks, a platform admin will review your idea. You&apos;ll hear back either way.
          </p>
        ) : (
          <>
            <p className="muted propose-sub">{sub}</p>
            {atCap && (
              <p className="propose-hint" role="status">
                {FEATURE_IDEA_MESSAGES.tooManyPending}
              </p>
            )}
            <div className="form-lock-host" aria-busy={lock.locked}>
              <label className="propose-label" htmlFor="propose-text">
                Your idea
              </label>
              <textarea
                id="propose-text"
                className="field"
                rows={6}
                autoFocus
                value={text}
                maxLength={FEATURE_IDEA_TEXT_MAX}
                placeholder="What should InnoBox do, and what would it help you with?"
                inert={lock.locked}
                onChange={(e) => setText(e.target.value.slice(0, FEATURE_IDEA_TEXT_MAX))}
              />
              <div className="propose-counter sub mono" aria-live="polite">
                {text.length} / {FEATURE_IDEA_TEXT_MAX}
              </div>
            </div>
            {error && (
              <p className="tag-error" role="alert">
                {error}
              </p>
            )}
          </>
        )}
        <div className="propose-actions">
          {sent ? (
            <button type="button" className="btn btn-sm" onClick={() => ref.current?.close()}>
              Close
            </button>
          ) : (
            <>
              <button type="button" className="btn btn-sm btn-ghost" disabled={lock.locked} onClick={tryClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-sm btn-primary" disabled={button.disabled || atCap || text.trim() === ""} data-testid="propose-send">
                <PrimaryButtonLabel state={button} />
              </button>
            </>
          )}
        </div>
      </form>
    </dialog>
  );
}

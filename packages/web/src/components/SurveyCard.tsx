"use client";
// The feedback survey card (INNOBOX_SPEC.md §13.10). Owned by AppShell and portaled to <body> so
// it survives client-side navigation; NOT a popover (it is one of the §2.2 exceptions). A
// non-modal dialog: the page stays usable, it never takes focus on appearance, and Escape closes it
// only when focus is inside it.
//
// Answers are local form state until Submit — nothing is sent per click. A reopened offer ("Take
// the survey") starts blank. Anonymous: nothing here sends an item id or anything about the user;
// the server stores the response with no reference to its author.
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { SURVEY_FREE_TEXT_MAX, type SurveyOfferPayload, type SurveyVia } from "@innobox/shared/survey";
import { StarInput } from "./StarInput";
import { useFormLock } from "./FormLock";

type Phase = "answering" | "submitting" | "thanks" | "expired";

export function SurveyCard({
  offer,
  via,
  hidden,
  onClose,
  onDone,
  onOptOut,
}: {
  offer: SurveyOfferPayload;
  via: SurveyVia;
  /** Hidden (not unmounted) while the mobile nav drawer or notification sheet is open. */
  hidden: boolean;
  /** ✕ / Escape while the offer is still open — "not now". */
  onClose: () => void;
  /** The card is finished (thanked, expired, or dismissed afterwards); the offer is gone. */
  onDone: (outcome: "submitted" | "expired") => void;
  /** "Don't ask me again" — resolves when the opt-out is saved, rejects with a message if not. */
  onOptOut: () => Promise<void>;
}) {
  const headingId = useId();
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [freeText, setFreeText] = useState("");
  const [phase, setPhase] = useState<Phase>("answering");
  const [error, setError] = useState<string | null>(null);
  const [optingOut, setOptingOut] = useState(false);
  // §2.2 submission lock: a second Submit while one is in flight is a no-op.
  const lock = useFormLock();

  // After the thank-you (or the expiry note) the card closes itself after ~4 s.
  useEffect(() => {
    if (phase !== "thanks" && phase !== "expired") return;
    const timer = window.setTimeout(() => onDone(phase === "thanks" ? "submitted" : "expired"), 4000);
    return () => window.clearTimeout(timer);
  }, [phase, onDone]);

  const answered = Object.keys(answers).length > 0 || freeText.trim() !== "";
  const busy = phase === "submitting" || optingOut;

  const dismiss = () => {
    if (phase === "thanks") onDone("submitted");
    else if (phase === "expired") onDone("expired");
    else onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      dismiss();
    }
  };

  const submit = async () => {
    if (!answered || busy || !lock.lock()) return;
    setPhase("submitting");
    setError(null);
    try {
      const body: Record<string, unknown> = { answers, via };
      const text = freeText.trim();
      if (text) body.freeText = text;
      // An on-demand offer always names its feature (none picked here → "InnoBox in general").
      if (offer.trigger === "self") body.feature = null;
      const res = await fetch("/api/me/survey/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 409) {
        lock.succeed();
        setPhase("expired");
        return;
      }
      if (!res.ok) throw new Error("submit failed");
      lock.succeed();
      setPhase("thanks");
    } catch {
      // Keep the answers; offer a retry.
      lock.release();
      setPhase("answering");
      setError("Your answers couldn't be sent. Please try again.");
    }
  };

  const optOut = async () => {
    setOptingOut(true);
    setError(null);
    try {
      await onOptOut();
    } catch {
      setError("That didn't work. Please try again.");
    } finally {
      setOptingOut(false);
    }
  };

  const general = offer.questions.filter((q) => q.section === "general");
  const feature = offer.questions.filter((q) => q.section === "feature");

  const card = (
    <div
      className="survey-card card"
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      data-testid="survey-card"
      hidden={hidden}
      onKeyDown={onKeyDown}
    >
      <div className="survey-head">
        <div className="grow">
          <h2 id={headingId} className="survey-title">
            How are we doing?
          </h2>
          {phase === "answering" || phase === "submitting" ? (
            <p className="survey-sub">About a minute. Anonymous: your name isn&apos;t stored with your answers. Answer as many as you like.</p>
          ) : null}
        </div>
        <button type="button" className="msg-close" aria-label="Close survey" onClick={dismiss}>
          ✕
        </button>
      </div>

      {phase === "thanks" && <p className="survey-done">Thanks — your feedback helps shape InnoBox.</p>}
      {phase === "expired" && <p className="survey-done">This survey has expired. Thanks anyway!</p>}

      {(phase === "answering" || phase === "submitting") && (
        <>
          <div className="survey-body" aria-busy={phase === "submitting"} inert={phase === "submitting"}>
            <div className="survey-section">InnoBox overall</div>
            {general.map((q) => (
              <Question key={q.key} id={`${headingId}-${q.key}`} text={q.text} value={answers[q.key] ?? null} disabled={busy} onChange={(v) => setAnswers((cur) => withAnswer(cur, q.key, v))} />
            ))}
            {feature.length > 0 && offer.feature && (
              <>
                <div className="survey-section">About {offer.feature.label}</div>
                {feature.map((q) => (
                  <Question key={q.key} id={`${headingId}-${q.key}`} text={q.text} value={answers[q.key] ?? null} disabled={busy} onChange={(v) => setAnswers((cur) => withAnswer(cur, q.key, v))} />
                ))}
              </>
            )}
            <label className="survey-q" htmlFor={`${headingId}-text`}>
              Anything you&apos;d change, fix or add?
            </label>
            <textarea
              id={`${headingId}-text`}
              className="field survey-text"
              rows={3}
              maxLength={SURVEY_FREE_TEXT_MAX}
              value={freeText}
              disabled={busy}
              onChange={(e) => setFreeText(e.target.value.slice(0, SURVEY_FREE_TEXT_MAX))}
            />
            <div className="survey-count mono" aria-live="off">
              {freeText.length} / {SURVEY_FREE_TEXT_MAX}
            </div>
          </div>

          <div className="survey-foot">
            {error && (
              <span className="survey-error" role="status">
                {error}
              </span>
            )}
            {offer.trigger !== "self" && (
              <button type="button" className="survey-optout" onClick={optOut} disabled={busy}>
                Don&apos;t ask me again
              </button>
            )}
            <button type="button" className="btn btn-primary btn-sm" onClick={submit} disabled={!answered || busy}>
              {phase === "submitting" ? "Sending…" : error ? "Try again" : "Submit"}
            </button>
          </div>
        </>
      )}
    </div>
  );

  return createPortal(card, document.body);
}

function withAnswer(current: Record<string, number>, key: string, value: number | null): Record<string, number> {
  const next = { ...current };
  if (value === null) delete next[key];
  else next[key] = value;
  return next;
}

function Question({ id, text, value, disabled, onChange }: { id: string; text: string; value: number | null; disabled: boolean; onChange: (v: number | null) => void }) {
  return (
    <div className="survey-question">
      <div className="survey-q" id={id}>
        {text}
      </div>
      <StarInput labelledBy={id} value={value} onChange={onChange} disabled={disabled} />
    </div>
  );
}

"use client";
// The feedback survey card (INNOBOX_SPEC.md §13.10). Owned by AppShell and portaled to <body> so
// it survives client-side navigation; NOT a popover (it is one of the §2.2 exceptions). A
// non-modal dialog: the page stays usable, it never takes focus on appearance, and Escape closes it
// only when focus is inside it.
//
// Answers are local form state until Submit — nothing is sent per click. A reopened offer ("Take
// the survey") starts blank. Anonymous: nothing here sends an item id or anything about the user;
// the server stores the response with no reference to its author.
//
// Bug mode (§13.10 *Bug reports*): the picker's Bug option hides every star question and asks for a
// required description instead. The card can also be OFFER-LESS — opened by the sidebar bug button
// with no survey open — and only becomes an on-demand survey if the user picks another category
// (the shell then starts one). The page path is captured on entering Bug mode: the path only,
// never the query string or the fragment.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  BUG_PICKER_VALUE,
  FEATURE_QUESTIONS,
  SURVEY_FREE_TEXT_MAX,
  isSurveyFeature,
  surveyFeatureLabel,
  surveyPickerOptions,
  surveyQuestionText,
  type SurveyFeature,
  type SurveyOfferPayload,
  type SurveyVia,
} from "@innobox/shared/survey";
import { StarInput } from "./StarInput";
import { useFormLock } from "./FormLock";
import { useDateFmt } from "./DateFormat";

type Phase = "answering" | "submitting" | "thanks" | "expired";

/** On an offer-less bug card: what the non-Bug picker options do. */
export type BugCardOthers = { state: "startable" } | { state: "cooldown"; nextAt: string } | { state: "random" };

/** The shell's answer when the offer-less card asks it to start an on-demand survey. */
export type StartSelfOutcome = { ok: true } | { ok: false; nextAt: string | null; random?: boolean };

export function SurveyCard({
  offer,
  via,
  hidden,
  bugReports,
  startInBug = false,
  others = { state: "startable" },
  bugSignal = 0,
  onClose,
  onDone,
  onOptOut,
  onStartSelf,
}: {
  /** The offer this card answers; null for an offer-less bug card. */
  offer: SurveyOfferPayload | null;
  via: SurveyVia;
  /** Hidden (not unmounted) while the mobile nav drawer or notification sheet is open. */
  hidden: boolean;
  /** Bug reports are on: the picker offers Bug. */
  bugReports: boolean;
  /** Open with Bug selected (the bug button). */
  startInBug?: boolean;
  /** Offer-less card only: whether the other categories can start an on-demand survey. */
  others?: BugCardOthers;
  /** Bumped by the shell when the bug button is clicked while this card is open: switch to Bug
   *  (if not already) and take focus. */
  bugSignal?: number;
  /** ✕ / Escape while the card is still answerable — "not now". */
  onClose: () => void;
  /** The card is finished (thanked, expired, or dismissed afterwards). */
  onDone: (outcome: "submitted" | "expired") => void;
  /** "Don't ask me again" — resolves when the opt-out is saved, rejects with a message if not. */
  onOptOut: () => Promise<void>;
  /** Offer-less card only: start an on-demand survey; on success the shell hands this card the
   *  new `self` offer. */
  onStartSelf?: () => Promise<StartSelfOutcome>;
}) {
  const headingId = useId();
  const fmt = useDateFmt();
  const cardRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [freeText, setFreeText] = useState("");
  const [phase, setPhase] = useState<Phase>("answering");
  const [error, setError] = useState<string | null>(null);
  const [optingOut, setOptingOut] = useState(false);
  // An on-demand offer has no feature: the user picks one here ("InnoBox in general" = none).
  const isSelf = offer?.trigger === "self";
  const offerless = offer === null;
  const [picked, setPicked] = useState<SurveyFeature | null>(null);
  // Bug mode, and the page captured on entering it.
  const capturePath = () => (typeof window === "undefined" ? null : window.location.pathname);
  const [bug, setBug] = useState(startInBug || offerless);
  const [bugPath, setBugPath] = useState<string | null>(() => (startInBug || offerless ? capturePath() : null));
  // Offer-less only: a start in flight, and a cooldown learnt from a lost race.
  const [starting, setStarting] = useState(false);
  const [lostRace, setLostRace] = useState<string | null>(null);
  // §2.2 submission lock: a second Submit while one is in flight is a no-op.
  const lock = useFormLock();

  // After the thank-you (or the expiry note) the card closes itself after ~4 s.
  useEffect(() => {
    if (phase !== "thanks" && phase !== "expired") return;
    const timer = window.setTimeout(() => onDone(phase === "thanks" ? "submitted" : "expired"), 4000);
    return () => window.clearTimeout(timer);
  }, [phase, onDone]);

  const enterBug = () => {
    if (!bug) {
      setBug(true);
      setBugPath(capturePath());
      // Switching to Bug discards any stars already set.
      setAnswers({});
    }
  };

  // The bug button clicked again while this card is open: Bug mode, and focus.
  const lastSignal = useRef(bugSignal);
  useEffect(() => {
    if (bugSignal === lastSignal.current) return;
    lastSignal.current = bugSignal;
    if (phase !== "answering") return;
    enterBug();
    window.setTimeout(() => (textRef.current ?? cardRef.current)?.focus(), 0);
  }, [bugSignal]); // enterBug and phase are read at signal time on purpose

  // Bug reports switched off meanwhile: an on-demand card in Bug mode snaps back to "in general"
  // (an offer-less card is closed by the shell).
  useEffect(() => {
    if (!bugReports && bug && !offerless) {
      setBug(false);
      setBugPath(null);
    }
  }, [bugReports, bug, offerless]);

  const description = freeText.trim();
  const answered = bug ? description !== "" : Object.keys(answers).length > 0 || description !== "";
  const busy = phase === "submitting" || optingOut || starting;

  const dismiss = () => {
    // A start in flight must land on an open card: closing now would strand the new offer.
    if (starting) return;
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

  const sendBug = async (fromOffer: boolean): Promise<Response> =>
    fetch("/api/me/survey/bug", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description, pagePath: bugPath, fromOffer }),
    });

  const submitBug = async () => {
    let res = await sendBug(isSelf);
    // The card's `self` offer ended meanwhile: the report still counts, just without it.
    if (res.status === 409 && isSelf && ((await res.clone().json().catch(() => ({}))) as { error?: string }).error === "no_open_survey") {
      res = await sendBug(false);
    }
    if (res.status === 409) throw new Error("Bug reports are off right now.");
    if (res.status === 429) throw new Error("You've sent several reports just now. Please try again later.");
    if (!res.ok) throw new Error("Your report couldn't be sent. Please try again.");
  };

  const submitSurvey = async (): Promise<"ok" | "expired"> => {
    const body: Record<string, unknown> = { answers, via };
    if (description) body.freeText = description;
    // An on-demand offer always names its feature (none picked here → "InnoBox in general").
    if (isSelf) body.feature = picked;
    const res = await fetch("/api/me/survey/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 409) return "expired";
    if (!res.ok) throw new Error("Your answers couldn't be sent. Please try again.");
    return "ok";
  };

  const submit = async () => {
    if (!answered || busy || !lock.lock()) return;
    setPhase("submitting");
    setError(null);
    try {
      if (bug) {
        await submitBug();
      } else if ((await submitSurvey()) === "expired") {
        lock.succeed();
        setPhase("expired");
        return;
      }
      lock.succeed();
      setPhase("thanks");
    } catch (e) {
      // Keep the text; offer a retry.
      lock.release();
      setPhase("answering");
      setError(e instanceof Error && e.message ? e.message : "That didn't work. Please try again.");
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

  // Offer-less: the other categories are disabled during the cooldown and while a random offer is
  // open; otherwise picking one starts an on-demand survey.
  const othersDisabled = offerless && (others.state !== "startable" || lostRace !== null);
  const othersHint = !offerless
    ? null
    : others.state === "random"
      ? "A survey is waiting for you: open Take the survey from the account menu."
      : others.state === "cooldown" || lostRace !== null
        ? `You can share other feedback again on ${fmt.date(lostRace ?? (others.state === "cooldown" ? others.nextAt : null))}.`
        : null;

  const pick = async (value: string) => {
    if (value === BUG_PICKER_VALUE) {
      enterBug();
      return;
    }
    const nextFeature = isSurveyFeature(value) ? value : null;
    if (offerless) {
      // Leaving Bug on an offer-less card starts an on-demand survey, now.
      if (othersDisabled || !onStartSelf) return;
      setStarting(true);
      setError(null);
      const outcome = await onStartSelf();
      setStarting(false);
      if (!outcome.ok) {
        // Lost a race with the cooldown (or the start failed): stay on Bug.
        if (outcome.nextAt) setLostRace(outcome.nextAt);
        else if (!outcome.random) setError("Feedback isn't available right now.");
        return;
      }
    }
    setBug(false);
    setBugPath(null);
    setPicked(nextFeature);
    // Changing or clearing the picked feature discards its questions' stars.
    setAnswers((cur) => Object.fromEntries(Object.entries(cur).filter(([key]) => !key.startsWith("feature."))));
  };

  const general = offer ? offer.questions.filter((q) => q.section === "general") : [];
  const aboutFeature = isSelf ? (picked ? { key: picked, label: surveyFeatureLabel(picked) } : null) : (offer?.feature ?? null);
  const feature = isSelf
    ? picked
      ? FEATURE_QUESTIONS.map((q) => ({ key: q.key, text: surveyQuestionText(q.key, surveyFeatureLabel(picked)) ?? q.key }))
      : []
    : (offer?.questions.filter((q) => q.section === "feature") ?? []);
  const showPicker = isSelf || offerless;
  const pickerValue = bug ? BUG_PICKER_VALUE : (picked ?? "");

  const card = (
    <div
      ref={cardRef}
      tabIndex={-1}
      className="survey-card card"
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      data-testid="survey-card"
      data-mode={bug ? "bug" : "survey"}
      hidden={hidden}
      onKeyDown={onKeyDown}
    >
      <div className="survey-head">
        <div className="grow">
          <h2 id={headingId} className="survey-title">
            {bug ? "Report a bug" : "How are we doing?"}
          </h2>
          {phase === "answering" || phase === "submitting" ? (
            <p className="survey-sub">
              {bug
                ? "Anonymous: your name isn't stored with your report. We attach the page you were on and the app version."
                : "About a minute. Anonymous: your name isn't stored with your answers. Answer as many as you like."}
            </p>
          ) : null}
        </div>
        <button type="button" className="msg-close" aria-label={bug ? "Close bug report" : "Close survey"} onClick={dismiss}>
          ✕
        </button>
      </div>

      {phase === "thanks" && <p className="survey-done">{bug ? "Thanks, we'll look into it." : "Thanks — your feedback helps shape InnoBox."}</p>}
      {phase === "expired" && <p className="survey-done">This survey has expired. Thanks anyway!</p>}

      {(phase === "answering" || phase === "submitting") && (
        <>
          <div className="survey-body" aria-busy={phase === "submitting" || starting} inert={phase === "submitting"}>
            {showPicker && (
              <div className="survey-question">
                <label className="survey-q" htmlFor={`${headingId}-topic`}>
                  What would you like to tell us about?
                </label>
                <select
                  id={`${headingId}-topic`}
                  className="field survey-topic"
                  data-testid="survey-topic"
                  value={pickerValue}
                  disabled={busy}
                  onChange={(e) => void pick(e.target.value)}
                >
                  {surveyPickerOptions(bugReports || bug).map((o) => (
                    <option key={o.value} value={o.value} disabled={o.value !== BUG_PICKER_VALUE && othersDisabled}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {othersHint && (
                  <p className="survey-hint" data-testid="survey-topic-hint">
                    {othersHint}
                  </p>
                )}
              </div>
            )}
            {!bug && (
              <>
                <div className="survey-section">InnoBox overall</div>
                {general.map((q) => (
                  <Question key={q.key} id={`${headingId}-${q.key}`} text={q.text} value={answers[q.key] ?? null} disabled={busy} onChange={(v) => setAnswers((cur) => withAnswer(cur, q.key, v))} />
                ))}
                {feature.length > 0 && aboutFeature && (
                  <>
                    <div className="survey-section">About {aboutFeature.label}</div>
                    {feature.map((q) => (
                      <Question key={q.key} id={`${headingId}-${q.key}`} text={q.text} value={answers[q.key] ?? null} disabled={busy} onChange={(v) => setAnswers((cur) => withAnswer(cur, q.key, v))} />
                    ))}
                  </>
                )}
              </>
            )}
            <label className="survey-q" htmlFor={`${headingId}-text`}>
              {bug ? "Describe the problem you found" : "Anything you'd change, fix or add?"}
            </label>
            <textarea
              ref={textRef}
              id={`${headingId}-text`}
              className="field survey-text"
              data-testid="survey-text"
              rows={bug ? 5 : 3}
              maxLength={SURVEY_FREE_TEXT_MAX}
              required={bug}
              placeholder={bug ? "What did you do, what did you expect, and what happened instead?" : undefined}
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
            {offer && offer.trigger !== "self" && (
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

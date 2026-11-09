"use client";
// "This affects me too" (INNOBOX_SPEC.md §41.3–§41.5): the button and its headcount popover, the
// "Who's affected" section on the challenge detail page, and the read-only reach count on cards,
// list rows and the triage queue. Everything shown comes from the API — the button's state from
// `canMarkAffected` / `affectedReason`, the numbers from `reach` / `affectedPeople` — so the client
// computes no rule. Markers are public by design; the authors arrive already masked.
//
// The popover is a <div>, never a <form>: it also opens inside the submit form's similar-challenges
// banner (§41.5), where a nested form would be invalid and would submit the challenge.
import { useEffect, useRef, useState } from "react";
import {
  AFFECTED_CLOSED_TOOLTIP,
  AFFECTED_HEADCOUNT_MAX,
  AFFECTED_HEADCOUNT_MIN,
  AFFECTED_MESSAGES,
  AFFECTED_POPOVER_HINT,
  AFFECTED_QUESTION,
  AFFECTED_SHOWN,
  REACH_EXPLANATION,
  affectedBreakdown,
  affectedButtonLabel,
  formatCount,
  reachLabel,
  type AffectedReason,
} from "@innobox/shared/affected";
import { AvatarBubble } from "@/components/AvatarBubble";
import { readJson } from "@/lib/api-client";

export const REACH_GLYPH = "👥";

export interface AffectedPerson {
  id: string;
  displayName: string;
  headcount: number;
  deactivated: boolean;
  scrubbed: boolean;
}

/** The block the detail payload and the mark routes return (§41.10). */
export interface AffectedBlock {
  reach: number;
  affectedPeople: number;
  affectedEstimate: number | null;
  affectedMine: number | null;
  canMarkAffected: boolean;
  affectedReason: AffectedReason;
  affected: AffectedPerson[];
}

/** The read-only reach — cards, list rows, triage, a trashed challenge's header (§41.5). */
export function ReachCount({ value, className = "chip", people }: { value: number; className?: string; people?: number }) {
  const label = reachLabel(value);
  return (
    <span className={className} title={`${label}. ${REACH_EXPLANATION}`} aria-label={label} data-testid="reach-count">
      {REACH_GLYPH} {formatCount(value)}
      {people !== undefined && <span className="reach-people"> · {formatCount(people)}</span>}
    </span>
  );
}

/** A whole number from 1 to 1,000 typed into the field, or null. */
function parseTyped(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= AFFECTED_HEADCOUNT_MIN && n <= AFFECTED_HEADCOUNT_MAX ? n : null;
}

/**
 * The §41.3 control: hidden for the authors (`own`) and before triage (`not_yet`); disabled once the
 * challenge closes (pressed when the viewer has a mark); otherwise a button that opens the headcount
 * popover. `onSaved` gets the refreshed block from the API.
 */
export function AffectedButton({
  challengeNumber,
  mine,
  reason,
  disabled = false,
  compact = false,
  onSaved,
  onError,
}: {
  challengeNumber: string;
  mine: number | null;
  reason: AffectedReason;
  disabled?: boolean;
  /** The smaller look of the similar-challenges banner. */
  compact?: boolean;
  onSaved: (block: AffectedBlock) => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = affectedButtonLabel(mine);
  const className = `btn btn-sm affected-btn${mine !== null ? " is-on" : ""}${compact ? " btn-ghost" : ""}`;
  if (reason === "own" || reason === "not_yet") return null;
  if (reason === "closed") {
    return (
      <button type="button" className={className} disabled aria-pressed={mine !== null} title={AFFECTED_CLOSED_TOOLTIP} data-testid="affected-button">
        {REACH_GLYPH} {label}
      </button>
    );
  }
  return (
    <span className="affected-anchor">
      <button
        type="button"
        className={className}
        disabled={disabled}
        aria-pressed={mine !== null}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        data-testid="affected-button"
      >
        {REACH_GLYPH} {label}
      </button>
      {open && (
        <AffectedPopover
          challengeNumber={challengeNumber}
          mine={mine}
          onClose={() => setOpen(false)}
          onSaved={(block) => {
            setOpen(false);
            onSaved(block);
          }}
          onError={onError}
        />
      )}
    </span>
  );
}

function AffectedPopover({
  challengeNumber,
  mine,
  onClose,
  onSaved,
  onError,
}: {
  challengeNumber: string;
  mine: number | null;
  onClose: () => void;
  onSaved: (block: AffectedBlock) => void;
  onError: (message: string) => void;
}) {
  const [value, setValue] = useState(String(mine ?? 1));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const path = `/api/challenges/${challengeNumber.replace(/\D/g, "")}/affected`;

  // The latest onClose, so the listeners below are attached once, on open.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    inputRef.current?.select();
    // Escape or a click outside (the trigger excepted — it toggles) closes without saving.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    const onDown = (e: MouseEvent) => {
      const anchor = ref.current?.parentElement;
      if (anchor && e.target instanceof Node && !anchor.contains(e.target)) closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, []);

  const send = async (method: "PUT" | "DELETE") => {
    const headcount = method === "PUT" ? parseTyped(value) : null;
    if (method === "PUT" && headcount === null) {
      setProblem(AFFECTED_MESSAGES.invalidHeadcount);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "PUT" ? JSON.stringify({ headcount }) : undefined,
      });
      const json = await readJson(res);
      if (res.status === 422) {
        setProblem(json.error ?? AFFECTED_MESSAGES.invalidHeadcount);
        return;
      }
      if (!res.ok) throw new Error(json.error ?? "Could not save your mark");
      onSaved(json as unknown as AffectedBlock);
    } catch (err) {
      onClose();
      onError(err instanceof Error ? err.message : "Could not save your mark");
    } finally {
      setBusy(false);
    }
  };

  const inputId = `affected-${challengeNumber}`;
  return (
    <div ref={ref} className="menu-pop affected-pop" role="dialog" aria-label={AFFECTED_QUESTION} data-testid="affected-popover">
      <div className="affected-pop-body">
        <label className="affected-pop-q" htmlFor={inputId}>
          {AFFECTED_QUESTION}
        </label>
        <input
          ref={inputRef}
          id={inputId}
          className="field"
          type="number"
          inputMode="numeric"
          min={AFFECTED_HEADCOUNT_MIN}
          max={AFFECTED_HEADCOUNT_MAX}
          step={1}
          value={value}
          aria-invalid={problem !== null}
          onChange={(e) => {
            setValue(e.target.value);
            setProblem(null);
          }}
          onKeyDown={(e) => {
            // Enter saves — the popover is not a form, so it never submits a surrounding one.
            if (e.key === "Enter") {
              e.preventDefault();
              void send("PUT");
            }
          }}
          disabled={busy}
        />
        {problem && (
          <div className="affected-pop-problem" role="alert">
            {problem}
          </div>
        )}
        <p className="sub affected-pop-hint">{AFFECTED_POPOVER_HINT}</p>
        <div className="affected-pop-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void send("PUT")}>
            {mine === null ? "Add" : "Save"}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          {mine !== null && (
            <button type="button" className="btn btn-ghost btn-sm affected-remove" disabled={busy} onClick={() => void send("DELETE")}>
              Remove my mark
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * "Who's affected" (§41.5): the reach, the breakdown line and the markers — largest headcount first,
 * the first 12 and "+N more". Rendered for every challenge the viewer can see.
 */
export function WhoIsAffected({
  block,
  teamSize,
  external,
}: {
  block: Pick<AffectedBlock, "reach" | "affectedPeople" | "affectedEstimate" | "affected">;
  teamSize: number;
  external: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? block.affected : block.affected.slice(0, AFFECTED_SHOWN);
  const more = block.affected.length - shown.length;
  return (
    <section className="affected" aria-label="Who's affected" data-testid="who-affected">
      <div className="affected-head">
        <strong data-testid="reach">{reachLabel(block.reach)}</strong>
        <span className="affected-info" title={REACH_EXPLANATION} aria-label={REACH_EXPLANATION} role="img" tabIndex={0}>
          ⓘ
        </span>
      </div>
      <div className="sub" data-testid="affected-breakdown">
        {affectedBreakdown({ estimate: block.affectedEstimate, teamSize, external, people: block.affectedPeople })}
      </div>
      {block.affected.length > 0 && (
        <ul className="affected-list" aria-label="Colleagues it affects">
          {shown.map((p) => (
            <li key={p.id} className="affected-chip" data-testid="affected-chip">
              <AvatarBubble size="sm" userId={p.id} displayName={p.displayName} deactivated={p.deactivated} scrubbed={p.scrubbed} />
              <span className="affected-name">{p.displayName}</span>
              <span className="mono affected-count">· {formatCount(p.headcount)}</span>
            </li>
          ))}
          {more > 0 && (
            <li>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setExpanded(true)} aria-label={`Show ${more} more`}>
                +{more} more
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

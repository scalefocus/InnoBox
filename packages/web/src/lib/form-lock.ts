// Submission lock — the pure state logic (INNOBOX_SPEC.md §6.4). The React glue (hook, scrim,
// button label) lives in components/FormLock.tsx; everything that decides *whether* a submit may
// start, when the lock lifts and what the primary button reads is here, so it is unit-testable
// without a DOM.
//
// Phases:
//   idle    — the form is editable; a submit may start.
//   working — a request is in flight; a second submit is a no-op.
//   held    — the request succeeded and the surface is about to go away (navigation, close).
//             The lock is never released from here, so no frame exists in which the form is
//             both submitted and clickable. Only `reset` (the form closing) returns to idle.

export type FormLockPhase = "idle" | "working" | "held";

export interface FormLockState {
  phase: FormLockPhase;
  /** Which item holds the lock, for a lock shared by several surfaces (the per-item Resubmit
   *  bars on the detail page). null for a single-form lock. */
  owner: string | null;
}

export type FormLockAction =
  | { type: "lock"; owner?: string | null }
  | { type: "release" }
  | { type: "succeed" }
  | { type: "reset" };

export const FORM_LOCK_IDLE: FormLockState = { phase: "idle", owner: null };

/** The label the primary button and the live region show while locked. */
export const WORKING_LABEL = "Working…";

/** The label of a button disabled because a staged upload is still scanning — not a lock. */
export const WAITING_FOR_ATTACHMENTS_LABEL = "Waiting for attachments…";

/** Returns the same object when nothing changes, so callers can detect a rejected action. */
export function formLockReducer(state: FormLockState, action: FormLockAction): FormLockState {
  switch (action.type) {
    case "lock":
      // A second submit while locked (double click, Enter) is rejected, whoever asks.
      if (state.phase !== "idle") return state;
      return { phase: "working", owner: action.owner ?? null };
    case "release":
      // Errors release; a success never does.
      if (state.phase !== "working") return state;
      return FORM_LOCK_IDLE;
    case "succeed":
      if (state.phase !== "working") return state;
      return { phase: "held", owner: state.owner };
    case "reset":
      return state.phase === "idle" ? state : FORM_LOCK_IDLE;
  }
}

export function isLocked(state: FormLockState): boolean {
  return state.phase !== "idle";
}

/** True when `owner` holds the lock (for the per-item Resubmit bars). */
export function isLockedFor(state: FormLockState, owner: string): boolean {
  return isLocked(state) && state.owner === owner;
}

/**
 * The duplicate check (§6.1) decides whether the lock lifts between the check and the create:
 * matches → release, so the author can read the banner, edit, or "Submit anyway"; no matches or
 * a failed check (advisory, never blocking — reported as []) → stay locked straight into the
 * create, with no release/re-lock flicker.
 */
export function afterSimilarityCheck(matches: readonly unknown[]): "warn" | "create" {
  return matches.length > 0 ? "warn" : "create";
}

export interface PrimaryButtonState {
  disabled: boolean;
  /** Show the shared `.spinner` before the label. */
  spinner: boolean;
  label: string;
}

/** What a locked form's primary button shows. `idleLabel` is the form's own resting label
 *  ("Submit challenge", "Submit anyway", "Submit solution", "Resubmit"…). */
export function primaryButtonState(input: { locked: boolean; attachmentsBusy?: boolean; idleLabel: string }): PrimaryButtonState {
  if (input.locked) return { disabled: true, spinner: true, label: WORKING_LABEL };
  if (input.attachmentsBusy) return { disabled: true, spinner: false, label: WAITING_FOR_ATTACHMENTS_LABEL };
  return { disabled: false, spinner: false, label: input.idleLabel };
}

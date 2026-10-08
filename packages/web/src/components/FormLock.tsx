"use client";
// Submission lock (INNOBOX_SPEC.md §6.4) — the one shared implementation behind the challenge
// form, the solution form and the Resubmit action. The state logic is pure (lib/form-lock.ts);
// this file is the React glue:
//
//   const lock = useFormLock();
//   if (!lock.lock()) return;        // in the submit handler — a second submit is a no-op
//   …error → lock.release()          // fields + staged files stay intact
//   …success → lock.succeed()        // never released; the surface navigates or closes
//
// Markup contract: the locked surface carries `form-lock` + `aria-busy`, its contents are made
// `inert`, the primary button carries `form-lock-raised` (it stays visible above the scrim), and
// <FormLockOverlay> renders the scrim plus the polite live region — outside the inert part, so
// the announcement is not swallowed.
import { useCallback, useMemo, useRef, useState } from "react";
import {
  FORM_LOCK_IDLE,
  WORKING_LABEL,
  formLockReducer,
  isLocked,
  isLockedFor,
  type FormLockAction,
  type FormLockState,
  type PrimaryButtonState,
} from "@/lib/form-lock";

export interface FormLock {
  state: FormLockState;
  /** True while a request is in flight or a success is being held. */
  locked: boolean;
  /** Start a submit. Returns false — and the caller must stop — when already locked. */
  lock: (owner?: string) => boolean;
  /** Lift the lock after a failure. A held (succeeded) lock is never released. */
  release: () => void;
  /** Mark success: the lock is held until the surface navigates away or closes. */
  succeed: () => void;
  /** Return to idle when the surface closes (so reopening it starts editable). */
  reset: () => void;
  /** True when `owner` holds the lock (a lock shared by several per-item bars). */
  lockedFor: (owner: string) => boolean;
}

export function useFormLock(): FormLock {
  // The ref is the synchronous source of truth for the handler guard: two submit events can
  // arrive before React re-renders, and both would still see `locked === false` in state.
  const ref = useRef<FormLockState>(FORM_LOCK_IDLE);
  const [state, setState] = useState<FormLockState>(FORM_LOCK_IDLE);

  const apply = useCallback((action: FormLockAction): boolean => {
    const next = formLockReducer(ref.current, action);
    if (next === ref.current) return false;
    ref.current = next;
    setState(next);
    return true;
  }, []);

  return useMemo<FormLock>(
    () => ({
      state,
      locked: isLocked(state),
      lock: (owner?: string) => apply({ type: "lock", owner: owner ?? null }),
      release: () => {
        apply({ type: "release" });
      },
      succeed: () => {
        apply({ type: "succeed" });
      },
      reset: () => {
        apply({ type: "reset" });
      },
      lockedFor: (owner: string) => isLockedFor(state, owner),
    }),
    [state, apply],
  );
}

/** The scrim (only while locked) and the polite live region that announces "Working…" once per
 *  lock. Render it as a direct child of the `form-lock` surface, outside its inert contents. */
export function FormLockOverlay({ locked }: { locked: boolean }) {
  return (
    <>
      {locked && <div className="form-lock-scrim" aria-hidden="true" data-testid="form-lock-scrim" />}
      <span className="form-lock-status" role="status" aria-live="polite">
        {locked ? WORKING_LABEL : ""}
      </span>
    </>
  );
}

/** The primary button's contents: the shared spinner + "Working…" while locked, else the label. */
export function PrimaryButtonLabel({ state }: { state: PrimaryButtonState }) {
  return (
    <>
      {state.spinner && <span className="spinner" aria-hidden="true" />}
      {state.label}
    </>
  );
}

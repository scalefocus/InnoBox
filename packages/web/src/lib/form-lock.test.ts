// Submission lock state logic (INNOBOX_SPEC.md §6.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FORM_LOCK_IDLE,
  WAITING_FOR_ATTACHMENTS_LABEL,
  WORKING_LABEL,
  afterSimilarityCheck,
  formLockReducer,
  isLocked,
  isLockedFor,
  primaryButtonState,
  type FormLockAction,
  type FormLockState,
} from "./form-lock";

function run(...actions: FormLockAction[]): FormLockState {
  return actions.reduce(formLockReducer, FORM_LOCK_IDLE);
}

test("starts idle and unlocked", () => {
  assert.equal(FORM_LOCK_IDLE.phase, "idle");
  assert.equal(isLocked(FORM_LOCK_IDLE), false);
});

test("a submit locks", () => {
  const s = run({ type: "lock" });
  assert.equal(s.phase, "working");
  assert.equal(isLocked(s), true);
});

test("a second submit while locked is rejected (same object back)", () => {
  const working = run({ type: "lock" });
  assert.equal(formLockReducer(working, { type: "lock" }), working);
  const held = formLockReducer(working, { type: "succeed" });
  assert.equal(formLockReducer(held, { type: "lock" }), held);
});

test("a second owner cannot take a lock another item holds", () => {
  const s = run({ type: "lock", owner: "a" });
  assert.equal(formLockReducer(s, { type: "lock", owner: "b" }), s);
  assert.equal(isLockedFor(s, "a"), true);
  assert.equal(isLockedFor(s, "b"), false);
});

test("an error releases the lock back to idle", () => {
  const s = run({ type: "lock" }, { type: "release" });
  assert.deepEqual(s, FORM_LOCK_IDLE);
  assert.equal(isLocked(s), false);
  // …so the author can submit again.
  assert.equal(formLockReducer(s, { type: "lock" }).phase, "working");
});

test("a success is held and never released", () => {
  const held = run({ type: "lock" }, { type: "succeed" });
  assert.equal(held.phase, "held");
  assert.equal(isLocked(held), true);
  assert.equal(formLockReducer(held, { type: "release" }), held);
});

test("success keeps the owner, so the item's bar stays covered until reset", () => {
  const held = run({ type: "lock", owner: "sol-1" }, { type: "succeed" });
  assert.equal(isLockedFor(held, "sol-1"), true);
});

test("reset (the surface closing) returns to idle from any phase", () => {
  assert.deepEqual(run({ type: "lock" }, { type: "succeed" }, { type: "reset" }), FORM_LOCK_IDLE);
  assert.deepEqual(run({ type: "lock" }, { type: "reset" }), FORM_LOCK_IDLE);
  assert.equal(formLockReducer(FORM_LOCK_IDLE, { type: "reset" }), FORM_LOCK_IDLE);
});

test("release and succeed while idle are no-ops", () => {
  assert.equal(formLockReducer(FORM_LOCK_IDLE, { type: "release" }), FORM_LOCK_IDLE);
  assert.equal(formLockReducer(FORM_LOCK_IDLE, { type: "succeed" }), FORM_LOCK_IDLE);
});

test("duplicate check: matches release, none (or a failed check) continue into the create", () => {
  assert.equal(afterSimilarityCheck([{ number: "CH-1" }]), "warn");
  assert.equal(afterSimilarityCheck([]), "create");
});

test("duplicate check flow: first submit locks before the check and holds through no matches", () => {
  // Submit → check finds nothing → create succeeds: one continuous lock, never released.
  let s = formLockReducer(FORM_LOCK_IDLE, { type: "lock" });
  assert.equal(afterSimilarityCheck([]), "create");
  assert.equal(s.phase, "working");
  s = formLockReducer(s, { type: "succeed" });
  assert.equal(s.phase, "held");
});

test("duplicate check flow: matches release, then Submit anyway locks again", () => {
  let s = formLockReducer(FORM_LOCK_IDLE, { type: "lock" });
  assert.equal(afterSimilarityCheck([{}]), "warn");
  s = formLockReducer(s, { type: "release" });
  assert.equal(isLocked(s), false);
  s = formLockReducer(s, { type: "lock" });
  assert.equal(s.phase, "working");
});

test("primary button: locked shows the spinner and Working…, disabled", () => {
  assert.deepEqual(primaryButtonState({ locked: true, idleLabel: "Submit challenge" }), {
    disabled: true,
    spinner: true,
    label: WORKING_LABEL,
  });
  // The lock wins over a pending upload label.
  assert.equal(primaryButtonState({ locked: true, attachmentsBusy: true, idleLabel: "x" }).label, "Working…");
});

test("primary button: waiting for attachments disables without a lock or spinner", () => {
  assert.deepEqual(primaryButtonState({ locked: false, attachmentsBusy: true, idleLabel: "Submit solution" }), {
    disabled: true,
    spinner: false,
    label: WAITING_FOR_ATTACHMENTS_LABEL,
  });
});

test("primary button: idle shows the form's own label", () => {
  assert.deepEqual(primaryButtonState({ locked: false, idleLabel: "Submit anyway" }), {
    disabled: false,
    spinner: false,
    label: "Submit anyway",
  });
});

test("the old per-form in-flight labels are gone", () => {
  for (const locked of [true, false]) {
    const { label } = primaryButtonState({ locked, idleLabel: "Submit challenge" });
    assert.notEqual(label, "Checking…");
    assert.notEqual(label, "Submitting…");
  }
});

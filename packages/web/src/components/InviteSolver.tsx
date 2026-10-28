"use client";
// Invite a solver on the challenge detail page (INNOBOX_SPEC.md §40.2, §40.3):
//   - InviteSolverButton — beside Propose a solution while the challenge accepts solutions
//     (`canInvite`); disabled with its hint once the viewer has used their room here or today. It
//     opens InviteSolverDialog, a native modal <dialog> (showModal gives the focus trap, Escape and
//     the inert page behind it): a people field backed by the `inviteFor` picker, an optional note
//     with a live counter, and the viewer's own "You invited" list — names only, never what anyone
//     did. Send locks while in flight; an error keeps the dialog and its fields.
//   - InvitationBanner — for an invitee with open invitations: the newest inviter named, up to three
//     stacked bubbles, the notes newest first (three, then "Show N more"), Propose a solution and a
//     quiet Not for me that tells nobody.
// The server re-checks everything; this module only renders what the payload carries.
import { useEffect, useRef, useState } from "react";
import {
  BANNER_NOTES_SHOWN,
  INVITE_CHALLENGE_CAP_HINT,
  INVITE_DAILY_CAP_HINT,
  INVITE_NOTE_MAX,
  invitationBannerHeadline,
  invitationsSentToast,
  sendInvitationsLabel,
} from "@innobox/shared/invitations";
import { PrimaryButtonLabel, useFormLock } from "@/components/FormLock";
import { primaryButtonState } from "@/lib/form-lock";
import { readJson } from "@/lib/api-client";
import { PersonBubble, TeamBubbles } from "./TeamByline";
import { UserResultButton, type UserResult } from "./UserResultButton";

/** A person in an invitation list (§40.11). */
export interface InvitationPerson {
  id: string;
  displayName: string;
  active: boolean;
}

/** The viewer's own block: who they invited here, and their room left. */
export interface InvitationsSent {
  sent: InvitationPerson[];
  left: number;
  leftToday: number;
}

/** One open invitation to the viewer. */
export interface InvitedBy extends InvitationPerson {
  note: string | null;
  invitedAt: string;
}

const asPerson = (p: InvitationPerson) => ({ userId: p.id, displayName: p.displayName, anonymous: false, active: p.active });

/** The Invite a solver button and its dialog. `challengeNumber` is "CH-12". */
export function InviteSolverButton({
  challengeNumber,
  invitations,
  busy,
  onSent,
}: {
  challengeNumber: string;
  invitations: InvitationsSent;
  busy: boolean;
  /** Called with the toast to show once the dialog has closed after a send. */
  onSent: (toast: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const hint = invitations.left === 0 ? INVITE_CHALLENGE_CAP_HINT : invitations.leftToday === 0 ? INVITE_DAILY_CAP_HINT : null;
  return (
    <>
      <span title={hint ?? undefined}>
        <button type="button" className="btn btn-sm" disabled={busy || hint !== null} onClick={() => setOpen(true)} data-testid="invite-solver">
          Invite a solver
        </button>
      </span>
      {hint && <span className="muted invite-hint">{hint}</span>}
      {open && <InviteSolverDialog challengeNumber={challengeNumber} invitations={invitations} onSent={onSent} onClose={() => setOpen(false)} />}
    </>
  );
}

function InviteSolverDialog({
  challengeNumber,
  invitations,
  onSent,
  onClose,
}: {
  challengeNumber: string;
  invitations: InvitationsSent;
  onSent: (toast: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [picked, setPicked] = useState<UserResult[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserResult[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const lock = useFormLock();
  // §40.2: the field is capped at the smaller of the room left here and today.
  const room = Math.min(invitations.left, invitations.leftToday);
  const full = picked.length >= room;

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const search = async (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) return setResults([]);
    const res = await fetch(`/api/users?q=${encodeURIComponent(q)}&inviteFor=${encodeURIComponent(challengeNumber)}`);
    const json = await readJson(res);
    const found = (json.users as UserResult[]) ?? [];
    setResults(found.filter((u) => !picked.some((p) => p.id === u.id)));
  };

  const pick = (u: UserResult) => {
    setPicked([...picked, u]);
    setQuery("");
    setResults([]);
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (picked.length === 0 || !lock.lock()) return;
    setError(null);
    try {
      const res = await fetch(`/api/challenges/${challengeNumber.replace("CH-", "")}/invitations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userIds: picked.map((p) => p.id), note: note.trim() === "" ? null : note }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Your invitations weren't sent. Try again.");
      lock.succeed();
      ref.current?.close();
      await onSent(invitationsSentToast(picked.length));
    } catch (err) {
      lock.release();
      setError(err instanceof Error ? err.message : "Your invitations weren't sent. Try again.");
    }
  };

  const button = primaryButtonState({ locked: lock.locked, idleLabel: sendInvitationsLabel(picked.length) });

  return (
    <dialog
      ref={ref}
      className="author-reveal-dialog propose-dialog"
      aria-labelledby="invite-title"
      data-testid="invite-dialog"
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === ref.current && !lock.locked) ref.current?.close();
      }}
    >
      <form className="propose-body" onSubmit={send}>
        <h2 id="invite-title" className="propose-title">
          Invite a solver to {challengeNumber}
        </h2>
        <p className="muted propose-sub">
          Know someone who could crack this? They&apos;re told in the app and by e-mail, with your note. Nobody else sees the invitation.
        </p>
        <div className="form-lock-host" aria-busy={lock.locked}>
          <label className="propose-label" htmlFor="invite-people">
            People
          </label>
          <div className="coauthor-picker" inert={lock.locked}>
            <div className="tag-field">
              <ul className="tag-list" aria-label="People to invite">
                {picked.map((u) => (
                  <li key={u.id} className="tag">
                    <span className="tag-label">{u.displayName}</span>
                    <button type="button" className="tag-remove" aria-label={`Remove ${u.displayName}`} onClick={() => setPicked(picked.filter((p) => p.id !== u.id))}>
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              {!full && (
                <input
                  id="invite-people"
                  className="tag-input"
                  autoFocus
                  placeholder={picked.length === 0 ? "Search colleagues by name or email…" : "Add another…"}
                  value={query}
                  data-testid="invite-people-field"
                  onChange={(e) => void search(e.target.value)}
                />
              )}
            </div>
            {results.length > 0 && (
              <div className="menu-pop user-search-pop coauthor-results">
                {results.map((u) => (
                  <UserResultButton key={u.id} user={u} onClick={() => pick(u)} />
                ))}
              </div>
            )}
            <div className="access-editor-hint">
              {room === 1 ? "You can invite 1 more person here." : `You can invite up to ${room} more people here.`} Only people who can see this challenge are
              offered.
            </div>
          </div>
          <label className="propose-label invite-note-label" htmlFor="invite-note">
            Note
          </label>
          <textarea
            id="invite-note"
            className="field invite-note"
            rows={3}
            value={note}
            maxLength={INVITE_NOTE_MAX}
            placeholder="Why them? (optional)"
            inert={lock.locked}
            data-testid="invite-note"
            onChange={(e) => setNote(e.target.value.slice(0, INVITE_NOTE_MAX))}
          />
          <div className="propose-counter sub mono" aria-live="polite">
            {note.length} / {INVITE_NOTE_MAX}
          </div>
          {invitations.sent.length > 0 && (
            <div className="invite-sent" data-testid="invite-sent">
              <span className="propose-label">You invited</span>
              <ul className="invite-sent-list">
                {invitations.sent.map((p) => (
                  <li key={p.id} className="invite-sent-item">
                    <PersonBubble person={asPerson(p)} />
                    <span>{p.displayName}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {error && (
          <p className="tag-error" role="alert">
            {error}
          </p>
        )}
        <div className="propose-actions">
          <button type="button" className="btn btn-sm btn-ghost" disabled={lock.locked} onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={button.disabled || picked.length === 0} data-testid="invite-send">
            <PrimaryButtonLabel state={button} />
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** The invitee's banner (§40.3) — rendered only while the payload carries open invitations. */
export function InvitationBanner({
  challengeNumber,
  inviters,
  canPropose,
  busy,
  onPropose,
  onDismissed,
  onError,
}: {
  challengeNumber: string;
  inviters: readonly InvitedBy[];
  canPropose: boolean;
  busy: boolean;
  onPropose: () => void;
  onDismissed: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const notes = inviters.filter((i) => i.note);
  const shown = expanded ? notes : notes.slice(0, BANNER_NOTES_SHOWN);

  const dismiss = async () => {
    setDismissing(true);
    try {
      const res = await fetch(`/api/challenges/${challengeNumber.replace("CH-", "")}/invitations/dismiss`, { method: "POST" });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not dismiss the invitation");
      await onDismissed();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not dismiss the invitation");
    } finally {
      setDismissing(false);
    }
  };

  return (
    <section className="invitation-banner" aria-label="Invitation to propose a solution" data-testid="invitation-banner">
      <div className="invitation-banner-head">
        <TeamBubbles authors={inviters.map(asPerson)} />
        <p className="invitation-banner-title">{invitationBannerHeadline(inviters.map((i) => i.displayName))}</p>
      </div>
      {shown.length > 0 && (
        <ul className="invitation-banner-notes">
          {shown.map((i) => (
            <li key={i.id} className="invitation-banner-note">
              <span className="invitation-banner-by">{i.displayName}:</span> &ldquo;{i.note}&rdquo;
            </li>
          ))}
        </ul>
      )}
      {!expanded && notes.length > BANNER_NOTES_SHOWN && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setExpanded(true)}>
          Show {notes.length - BANNER_NOTES_SHOWN} more
        </button>
      )}
      <div className="invitation-banner-actions">
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !canPropose} onClick={onPropose} data-testid="invitation-propose">
          Propose a solution
        </button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy || dismissing} onClick={() => void dismiss()} data-testid="invitation-dismiss">
          Not for me
        </button>
      </div>
    </section>
  );
}

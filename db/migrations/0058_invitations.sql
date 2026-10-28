-- 0058_invitations.sql — invite a solver (INNOBOX_SPEC.md §40, §40.10).
--
--   challenge_invitations — one row per (challenge, inviter, invitee), ever: an invitation to
--       propose a solution, with the inviter's optional plain-text note (at most 500 characters).
--       Immutable once written (§40 decision 5), except the payoff's two columns, set once in the
--       transaction that counts it (§40.5) — the only UPDATE the app role holds, column by column.
--       DELETE serves the §10.3 cascade (which counts what it removes) and the §3 erasure, which
--       deletes the person's invitations sent and received. The caps (5 per challenge per inviter,
--       20 a UTC day per inviter) are the API's, under a per-inviter advisory lock (§40.2).
--   challenge_invitation_dismissals — the invitee's quiet "Not for me" per challenge (§40.3): the
--       banner goes for good and later invitations to that challenge write no event 22. Nobody else
--       ever reads it. DELETE serves the cascade and the erasure.
--   users.notify_invitations — the "Invitations to propose a solution" preference (§40.6), on by
--       default: it gates §12.1 event 22 at insert time, like the three follower toggles (0025).
--   gamification_ledger.reason gains the 0-point invite_fulfilled that drives the Matchmaker badge
--       (§40.7). It names the answering solution as its item.
--
-- Both tables cascade with their challenge (ON DELETE CASCADE) as a backstop; the §10.3 purge
-- deletes them explicitly first so its audit row can count them. Deleting a solution nulls the
-- paid_off_solution_id that points at it and keeps paid_off_at (§40.8).

CREATE TABLE IF NOT EXISTS challenge_invitations (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  challenge_id          uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  inviter_id            uuid NOT NULL REFERENCES users(id),
  invitee_id            uuid NOT NULL REFERENCES users(id),
  note                  text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  created_at            timestamptz NOT NULL DEFAULT now(),
  paid_off_at           timestamptz,
  paid_off_solution_id  uuid REFERENCES solutions(id) ON DELETE SET NULL,
  CONSTRAINT challenge_invitations_not_self CHECK (invitee_id <> inviter_id),
  CONSTRAINT challenge_invitations_once UNIQUE (challenge_id, inviter_id, invitee_id)
);
-- The banner and the payoff lookup read by invitee; the daily cap counts by inviter and day.
CREATE INDEX IF NOT EXISTS challenge_invitations_invitee_idx ON challenge_invitations (invitee_id, challenge_id);
CREATE INDEX IF NOT EXISTS challenge_invitations_inviter_idx ON challenge_invitations (inviter_id, created_at);

CREATE TABLE IF NOT EXISTS challenge_invitation_dismissals (
  challenge_id  uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id),
  dismissed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, user_id)
);
CREATE INDEX IF NOT EXISTS challenge_invitation_dismissals_user_idx ON challenge_invitation_dismissals (user_id);

GRANT SELECT, INSERT, DELETE ON challenge_invitations TO innobox_app;  -- DELETE: §10.3 cascade + §3 erasure only
GRANT UPDATE (paid_off_at, paid_off_solution_id) ON challenge_invitations TO innobox_app;  -- the payoff, set once
GRANT SELECT, INSERT, DELETE ON challenge_invitation_dismissals TO innobox_app;

ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_invitations boolean NOT NULL DEFAULT true;

-- §40.7: the new ledger reason. Rewritten whole, as 0054 did; it names an item (the solution), so
-- the item check is unchanged.
ALTER TABLE gamification_ledger DROP CONSTRAINT IF EXISTS gamification_ledger_reason_check;
ALTER TABLE gamification_ledger ADD CONSTRAINT gamification_ledger_reason_check CHECK (reason IN (
  'challenge_submitted', 'challenge_validated', 'challenge_solved', 'assignment_solved',
  'solution_proposed', 'solution_validated', 'solution_implemented',
  'like_received', 'comment_posted', 'agent_connected',
  'hype_received', 'hype_fulfilled',
  'idea_approved', 'idea_shipped',
  'invite_fulfilled'));

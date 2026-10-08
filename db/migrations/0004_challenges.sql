-- 0004_challenges.sql — Phase 2 first slice (INNOBOX_SPEC.md §5, §13.1): challenges,
-- solutions, impact_areas, likes. Statuses are plain-text CHECKs (§7.1/§8.1 vocab);
-- the enforced state machines (§7.2/§8.2) are application logic, not DB constraints —
-- this slice only ships the admin free-set override, which writes any legal status.
-- Numbers (CH-<n> / SOL-<n>) are globally-increasing identity columns; the display
-- prefix is presentation-only, added by the app.

CREATE TABLE IF NOT EXISTS impact_areas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text UNIQUE NOT NULL,
  active        boolean NOT NULL DEFAULT true
);
INSERT INTO impact_areas (name) VALUES ('Client'), ('Internal'), ('Accelerator')
  ON CONFLICT (name) DO NOTHING;                  -- §5 seeded impact areas

CREATE TABLE IF NOT EXISTS challenges (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number         bigint GENERATED ALWAYS AS IDENTITY,  -- display: CH-<number>
  namespace_id   uuid NOT NULL REFERENCES namespaces(id),
  visibility     text NOT NULL DEFAULT 'org' CHECK (visibility IN ('org','namespace')),
  title          text NOT NULL,
  description    text NOT NULL,
  impact_area_id uuid NOT NULL REFERENCES impact_areas(id),
  client_name    text,                            -- required iff impact area = Client (app-validated, §5)
  is_anonymous   boolean NOT NULL DEFAULT false,
  author_id      uuid NOT NULL REFERENCES users(id),
  assignee_id    uuid REFERENCES users(id),        -- §7.3 assignment: column exists, no UI yet this slice
  status         text NOT NULL DEFAULT 'awaiting_triage' CHECK (status IN (
                   'awaiting_triage','in_review','needs_improvement','meeting_scheduled',
                   'valid','solved','rejected','withdrawn'
                 )),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  edited_at      timestamptz,
  resolved_at    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS challenges_number_idx ON challenges (number);
CREATE INDEX IF NOT EXISTS challenges_namespace_idx ON challenges (namespace_id);
CREATE INDEX IF NOT EXISTS challenges_status_idx ON challenges (status);
CREATE INDEX IF NOT EXISTS challenges_author_idx ON challenges (author_id);

CREATE TABLE IF NOT EXISTS solutions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number            bigint GENERATED ALWAYS AS IDENTITY,  -- display: SOL-<number>
  challenge_id      uuid NOT NULL REFERENCES challenges(id),
  description       text NOT NULL,
  cost_vs_benefits  text,
  is_anonymous      boolean NOT NULL DEFAULT false,
  author_id         uuid NOT NULL REFERENCES users(id),
  status            text NOT NULL DEFAULT 'proposed' CHECK (status IN (
                      'proposed','in_review','needs_improvement','valid','accepted_internally',
                      'waiting_for_resources','in_implementation','external_acceptance',
                      'implemented','rejected','not_selected','withdrawn'
                    )),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  edited_at         timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS solutions_number_idx ON solutions (number);
CREATE INDEX IF NOT EXISTS solutions_challenge_idx ON solutions (challenge_id);
CREATE INDEX IF NOT EXISTS solutions_status_idx ON solutions (status);
CREATE INDEX IF NOT EXISTS solutions_author_idx ON solutions (author_id);
-- Invariant 7 (non-negotiable, §8.3): at most one solution per challenge may be at or
-- past accepted_internally. Enforced at the DB level, not just app logic, so a race
-- between two concurrent admin overrides can't slip a second winner through.
CREATE UNIQUE INDEX IF NOT EXISTS solutions_single_winner_idx ON solutions (challenge_id)
  WHERE status IN ('accepted_internally','waiting_for_resources','in_implementation','external_acceptance','implemented');

-- Minimal likes slice, pulled forward from Phase 3 to power the §13.1 gallery's like
-- count/sort. Toggle = insert-or-delete; comments/likes are never anonymous (§9).
CREATE TABLE IF NOT EXISTS likes (
  user_id      uuid NOT NULL REFERENCES users(id),
  parent_type  text NOT NULL CHECK (parent_type IN ('challenge','solution')),
  parent_id    uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, parent_type, parent_id)
);
CREATE INDEX IF NOT EXISTS likes_parent_idx ON likes (parent_type, parent_id);

-- Least-privilege grants: no DELETE on challenges/solutions (withdrawal is a status,
-- not a row delete); likes toggle via insert/delete; impact_areas is read-only here
-- (management is §14.3 platform settings, Phase 4).
GRANT SELECT                 ON impact_areas TO innobox_app;
GRANT SELECT, INSERT, UPDATE ON challenges    TO innobox_app;
GRANT SELECT, INSERT, UPDATE ON solutions     TO innobox_app;
GRANT SELECT, INSERT, DELETE ON likes         TO innobox_app;

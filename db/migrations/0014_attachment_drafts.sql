-- 0014_attachment_drafts.sql — staged attachments at submission (INNOBOX_SPEC.md §11, §6.1/§6.2).
-- Submission forms attach files BEFORE the parent challenge/solution exists, so an upload can be
-- "staged": stored with no parent_id but a client-generated draft_key, then bound to the new item
-- inside the create transaction. A staged row has (parent_id IS NULL, draft_key set); a bound row
-- has (parent_id set, draft_key NULL) — a CHECK enforces exactly one. Abandoned staged rows are
-- GC'd by the worker after 24h (soft-removed like any other tombstone — no DELETE grant). Idempotent.

-- parent_id becomes nullable (null while staged). DROP NOT NULL is a no-op if already dropped.
ALTER TABLE attachments ALTER COLUMN parent_id DROP NOT NULL;

-- draft_key: set only while staged, cleared on binding.
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS draft_key uuid;

-- Exactly one of parent_id / draft_key is present. Existing (bound) rows satisfy this already.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_parent_xor_draft') THEN
    ALTER TABLE attachments
      ADD CONSTRAINT attachments_parent_xor_draft CHECK ((parent_id IS NULL) <> (draft_key IS NULL));
  END IF;
END $$;

-- Staged-row lookups (list-by-draft, binding, GC) hit only unbound rows.
CREATE INDEX IF NOT EXISTS attachments_draft_key_idx ON attachments (draft_key) WHERE draft_key IS NOT NULL;

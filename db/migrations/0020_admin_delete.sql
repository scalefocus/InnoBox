-- 0020_admin_delete.sql — platform-admin permanent delete of a challenge/solution
-- (INNOBOX_SPEC.md §10.3). This is the ONE path in the app that hard-deletes domain rows:
-- everything else is soft (comment deleted_at §10.2, attachment tombstones §11, withdrawn
-- statuses §10.1). The cascade is written in app SQL inside a single transaction rather than
-- as ON DELETE CASCADE foreign keys, because comments/likes/follows/attachments are
-- polymorphic (parent_type + parent_id, no FK to challenges/solutions) and because each
-- delete must also write its audit row (§15) in the same transaction.
--
-- `likes` and `follows` already carry DELETE (unlike/unfollow toggles). `audit_log` never
-- will — append-only, enforced by both grants and a trigger (invariant 5). These grants exist
-- to serve the §10.3 cascade and nothing else. Idempotent.

GRANT DELETE ON challenges          TO innobox_app;
GRANT DELETE ON solutions           TO innobox_app;
GRANT DELETE ON comments            TO innobox_app;
GRANT DELETE ON attachments         TO innobox_app;
GRANT DELETE ON notifications       TO innobox_app;
GRANT DELETE ON notification_outbox TO innobox_app;

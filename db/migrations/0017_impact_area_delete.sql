-- 0017_impact_area_delete.sql — Phase 4 (INNOBOX_SPEC.md §5, §14.3): platform admins can
-- DELETE a retired impact area. This SUPERSEDES the "No DELETE" stance in
-- 0009_impact_area_grants.sql: a retired area can now be removed — either when no challenge
-- references it, or by reassigning its challenges to another active area first (app-side, in
-- one transaction; the challenge's client_name is cleared since the destination is never
-- Client, §5). The challenges → impact_areas FK stays RESTRICT (no ON DELETE cascade): the app
-- always moves references off the row FIRST, then deletes, so a delete can never orphan or
-- silently drop a challenge. Only retired areas are deletable (enforced in the app). Idempotent.

GRANT DELETE ON impact_areas TO innobox_app;

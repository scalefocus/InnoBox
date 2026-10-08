-- 0009_impact_area_grants.sql — Phase 4 (INNOBOX_SPEC.md §14.3): impact area management
-- (add / rename / retire) lands in this phase. 0004_challenges.sql deliberately granted only
-- SELECT ("management is §14.3 platform settings, Phase 4") — this migration adds the write
-- grants now that the settings page exists. No DELETE: retiring is a soft flip of `active`,
-- never a row removal (historical items must keep their impact area name).

GRANT INSERT, UPDATE ON impact_areas TO innobox_app;

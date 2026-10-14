-- 0046_scim_rejection_detail.sql — the real client address on the worker's SCIM 401/403
-- system-log rows (INNOBOX_SPEC.md §5, §14.7 *SCIM rejection detail*).
--
--   system_events.client_ip — set ONLY by the worker's SCIM recorder, from the address
--     `trust proxy` selects (the SCIM rate limiter's key), so a call from Entra's provisioning
--     service can be told apart from anyone else probing the endpoint. Stored in full; web-tier
--     rows and every other worker row leave it null. The rows carry no user, so GDPR erasure
--     does not touch them; the 90-day trim removes the address with the rest of the row.
--     Not part of the trigram search expression (system_events_search_trgm_idx is unchanged).
--
-- The reason codes (scim_no_token | scim_not_bearer | scim_token_mismatch | scim_forbidden) live
-- in the existing free-text error_code column; no schema change is needed for them.

ALTER TABLE system_events ADD COLUMN IF NOT EXISTS client_ip text;
ALTER TABLE system_events DROP CONSTRAINT IF EXISTS system_events_client_ip_len;
ALTER TABLE system_events ADD CONSTRAINT system_events_client_ip_len CHECK (client_ip IS NULL OR char_length(client_ip) <= 64);

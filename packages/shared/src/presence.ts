// Presence SQL shared by the web read path (api/admin/presence/store.ts) and the worker's daily
// WAU/MAU snapshot (worker presence/rollup.ts) — INNOBOX_SPEC.md §14.5.
//
// The snapshot is defined as "the tiles' own formula, sampled once a day", so the two must
// never drift apart: one person filter and one pair of window lengths, imported by both.

/** The rolling windows behind the WAU and MAU tiles and the chart's weekly/monthly lines. */
export const PRESENCE_WAU_DAYS = 7;
export const PRESENCE_MAU_DAYS = 30;

/**
 * Who counts as a person in presence (alias the users table `u`). Scrubbed users are gone from
 * presence entirely (§3 — the erasure wipes their timestamps, so this is belt-and-braces), and
 * the e-mail service mailbox (§12) is not a person: it is matched by the Entra object id the
 * admin connected, so it needs no magic name list. Deactivated users DO count — they can only
 * show up in the longer windows, because sign-in cuts them off.
 */
export const PRESENCE_REAL_PEOPLE_SQL = `
  u.scrubbed_at is null
  and u.last_seen_at is not null
  and not exists (select 1 from email_service_account esa where esa.account_oid = u.external_id)
`;

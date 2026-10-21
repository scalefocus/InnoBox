// Write path for the §14.12 beacon (INNOBOX_SPEC.md): a validated beacon becomes rum_views rows
// and deduplicated rum_client_errors rows. Nothing here takes a person: the signature has no user
// parameter and neither table has a user column, so "the insert does not see the session" is a
// property of the code's shape, not a promise (§14.12 decision 2).
// Relative imports only (no `@/`) so the gated dbtests can load it.
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { errorFingerprintInput, type RumBeacon, type RumErrorInput } from "@innobox/shared/rum";

/** SHA-256 of the normalised message plus the source file and line, hex. */
export function errorFingerprint(message: string, source: string): string {
  return createHash("sha256").update(errorFingerprintInput(message, source)).digest("hex");
}

interface ErrorBatchRow extends RumErrorInput {
  fingerprint: string;
  count: number;
}

/** Collapses a batch's errors by fingerprint, so one upsert never touches a row twice. The most
 *  recent occurrence's text and route win. */
export function collapseErrors(errors: readonly RumErrorInput[]): ErrorBatchRow[] {
  const byPrint = new Map<string, ErrorBatchRow>();
  for (const e of errors) {
    const fingerprint = errorFingerprint(e.message, e.source);
    const prev = byPrint.get(fingerprint);
    byPrint.set(fingerprint, { ...e, fingerprint, count: (prev?.count ?? 0) + 1 });
  }
  return [...byPrint.values()];
}

export async function insertRumBeacon(pool: Pool, beacon: RumBeacon): Promise<{ views: number; errors: number }> {
  let views = 0;
  if (beacon.views.length > 0) {
    const rows = beacon.views.map((v) => ({
      day: v.day,
      route: v.route,
      hard_load: v.hardLoad,
      lcp_ms: v.lcpMs,
      inp_ms: v.inpMs,
      nav_ms: v.navMs,
      ttfb_ms: v.ttfbMs,
      cls: v.cls,
      api_ms: v.apiMs,
      api_calls: v.apiCalls,
      api_errors: v.apiErrors,
      client_errors: v.clientErrors,
    }));
    const res = await pool.query(
      `insert into rum_views (day, session_id, route, hard_load, lcp_ms, inp_ms, nav_ms, ttfb_ms, cls,
                              api_ms, api_calls, api_errors, client_errors)
       select x.day, $2, x.route, x.hard_load, x.lcp_ms, x.inp_ms, x.nav_ms, x.ttfb_ms, x.cls,
              array(select jsonb_array_elements_text(x.api_ms)::int),
              x.api_calls, x.api_errors, x.client_errors
         from jsonb_to_recordset($1::jsonb) as x(
                day date, route text, hard_load boolean, lcp_ms int, inp_ms int, nav_ms int, ttfb_ms int,
                cls numeric, api_ms jsonb, api_calls int, api_errors int, client_errors int)`,
      [JSON.stringify(rows), beacon.sessionId],
    );
    views = res.rowCount ?? 0;
  }

  let errors = 0;
  const batch = collapseErrors(beacon.errors);
  if (batch.length > 0) {
    const res = await pool.query(
      `insert into rum_client_errors (fingerprint, message, source, frame, route, count)
       select x.fingerprint, x.message, x.source, x.frame, x.route, x.count
         from jsonb_to_recordset($1::jsonb) as x(fingerprint text, message text, source text, frame text, route text, count int)
       on conflict (fingerprint) do update
         set count = rum_client_errors.count + excluded.count,
             last_seen = now(),
             route = excluded.route,
             frame = excluded.frame`,
      [JSON.stringify(batch)],
    );
    errors = res.rowCount ?? 0;
  }
  return { views, errors };
}

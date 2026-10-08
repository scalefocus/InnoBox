// Query parsing for the §15 audit browser endpoints — shared by the listing and the CSV export so
// "exports what is on screen" is true by construction. Malformed uuid/timestamp values are ignored
// (treated as unset) rather than 500-ing the query.
import { parseAuditCategory } from "@innobox/shared";
import type { AuditFilters } from "./store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_MAX = 200;

export function parseAuditQuery(q: URLSearchParams): AuditFilters {
  const str = (k: string): string | undefined => {
    const v = q.get(k);
    return v && v.trim() ? v.trim() : undefined;
  };
  const uuid = (k: string): string | undefined => {
    const v = str(k);
    return v && UUID_RE.test(v) ? v : undefined;
  };
  const iso = (k: string): string | undefined => {
    const v = str(k);
    if (!v) return undefined;
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
  };
  const search = str("q");
  return {
    category: parseAuditCategory(q.get("category")),
    q: search ? search.slice(0, SEARCH_MAX) : undefined,
    action: str("action"),
    actorUserId: uuid("actorUserId"),
    targetType: str("targetType"),
    targetId: str("targetId"),
    from: iso("from"),
    to: iso("to"),
  };
}

// Query parsing for the §14.7 system log endpoints — shared by the listing and the CSV export so
// "exports what is on screen" is true by construction. Malformed values are ignored (treated as
// unset), never 500s.
import { parseSystemLogStatusFilter } from "@innobox/shared";
import type { SystemLogFilters } from "./store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_MAX = 200;

export function parseSystemLogQuery(q: URLSearchParams): SystemLogFilters {
  const str = (k: string): string | undefined => {
    const v = q.get(k);
    return v && v.trim() ? v.trim() : undefined;
  };
  const iso = (k: string): string | undefined => {
    const v = str(k);
    if (!v) return undefined;
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
  };
  const userId = str("userId");
  const search = str("q");
  return {
    status: parseSystemLogStatusFilter(q.get("status")),
    q: search ? search.slice(0, SEARCH_MAX) : undefined,
    from: iso("from"),
    to: iso("to"),
    userId: userId && UUID_RE.test(userId) ? userId : undefined,
  };
}

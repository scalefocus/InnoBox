// GET /api/search?q=[&status=&impactAreaId=&namespaceId=&authorName=] (INNOBOX_SPEC.md §13.4):
// full-text search + exact number lookup, narrowed by the §13.1 gallery filters.
// Auth-required; results are visibility-filtered and anonymity-masked (invariants 2-3).
import { SEARCH_QUERY_MAX } from "@innobox/shared";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { search } from "./store";
import { parseGalleryFilters } from "../challenges/validation";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "search");
  if (limited) return limited;

  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  if (q.length > SEARCH_QUERY_MAX) {
    return Response.json({ error: `q must be at most ${SEARCH_QUERY_MAX} characters` }, { status: 400 });
  }
  // §13.4: the §13.1 gallery filters narrow the results; a malformed one fails closed (400),
  // exactly as on the gallery, rather than silently widening the result set.
  const filters = parseGalleryFilters(url.searchParams);
  if (!filters.ok) return Response.json({ error: filters.error }, { status: 400 });
  if (q.trim() === "") return Response.json({ challenges: [], solutions: [] });

  const results = await search(pool, { userId: gate.user.id, roles: gate.user.roles }, q, filters.value);
  return Response.json(results);
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/search", handleGET);

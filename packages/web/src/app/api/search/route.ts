// GET /api/search?q= (INNOBOX_SPEC.md §13.4): full-text search + exact number lookup.
// Auth-required; results are visibility-filtered and anonymity-masked (invariants 2-3).
import { SEARCH_QUERY_MAX } from "@innobox/shared";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { search } from "./store";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  if (q.trim() === "") return Response.json({ challenges: [], solutions: [] });
  if (q.length > SEARCH_QUERY_MAX) {
    return Response.json({ error: `q must be at most ${SEARCH_QUERY_MAX} characters` }, { status: 400 });
  }

  const results = await search(pool, { userId: gate.user.id, roles: gate.user.roles }, q);
  return Response.json(results);
}

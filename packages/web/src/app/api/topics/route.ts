// GET /api/topics (INNOBOX_SPEC.md §34.6, §34.9): the active topics, alphabetical, with the
// viewer's follow state and their own open count — what `/topics`, the profile's Topics section
// and the submit form's picker read. Any signed-in user; topic names are not restricted content,
// and every count is computed within the viewer's visibility (invariant 2). `?include=retired`
// adds the retired topics (after the active ones) for a namespace or platform admin — the triage
// filter's list; for anyone else it is ignored.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { adminNamespaceIds } from "../admin/triage/store";
import { listTopicsForViewer } from "./store";

export const dynamic = "force-dynamic";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const viewer = { userId: gate.user.id, roles: gate.user.roles };
  const ns = adminNamespaceIds(viewer.roles);
  const includeRetired = new URL(req.url).searchParams.get("include") === "retired" && (ns === "all" || ns.length > 0);
  const topics = await listTopicsForViewer(pool, viewer, { includeRetired });
  return Response.json({ topics });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/topics", handleGET);

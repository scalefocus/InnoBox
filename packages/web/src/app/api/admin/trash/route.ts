// GET /api/admin/trash (INNOBOX_SPEC.md §10.4): every trashed challenge and solution, newest
// first, with an optional `?q=` filter on number and title. Platform admins only — anyone else gets
// 404, not 403, like every other trash route (the trash is never an existence oracle).
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { listTrash } from "../../challenges/trash";

export const dynamic = "force-dynamic";

/** The longest filter accepted — longer input is cut, never refused. */
const TRASH_QUERY_MAX = 200;

async function handleGET(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, TRASH_QUERY_MAX);
  const items = await listTrash(pool, { userId: gate.user.id, roles: gate.user.roles }, q);
  if (items === null) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ items });
}

export const GET = withSystemLog("/api/admin/trash", handleGET);

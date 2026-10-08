// GET /api/admin/triage/solutions (INNOBOX_SPEC.md §14.1 Solutions tab): the namespace's
// `proposed` solutions awaiting review. Same RBAC/visibility as the challenges queue (namespace
// admins → their namespaces, platform admins → everywhere); anonymous authors masked (§9).
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { adminNamespaceIds, listTriageSolutions } from "../store";
import { parseTriagePagination } from "../validation";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const viewer = { userId: gate.user.id, roles: gate.user.roles };
  const adminNs = adminNamespaceIds(viewer.roles);
  if (adminNs !== "all" && adminNs.length === 0) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const pagination = parseTriagePagination(url.searchParams);
  if (!pagination.ok) return Response.json({ error: pagination.error }, { status: 400 });

  const page = await listTriageSolutions(pool, viewer, pagination.value);
  return Response.json(page);
}

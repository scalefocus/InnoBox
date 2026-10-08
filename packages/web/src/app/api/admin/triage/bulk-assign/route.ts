// POST /api/admin/triage/bulk-assign (INNOBOX_SPEC.md §14.1): bulk assign/unassign over a
// selection — each item audited individually via setChallengeAssignee.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { adminNamespaceIds, bulkAssign } from "../store";
import { parseBulkAssignBody } from "../validation";

export async function POST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const admin = { userId: gate.user.id, roles: gate.user.roles };
  const adminNs = adminNamespaceIds(admin.roles);
  if (adminNs !== "all" && adminNs.length === 0) return Response.json({ error: "forbidden" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const parsed = parseBulkAssignBody(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const outcomes = await bulkAssign(pool, admin, parsed.value.numbers, parsed.value.assigneeUserId);
  return Response.json({ outcomes });
}

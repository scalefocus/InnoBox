// POST /api/admin/triage/bulk-assign (INNOBOX_SPEC.md §14.1): bulk assign/unassign over a
// selection — each item audited individually via setChallengeAssignee and notified exactly like
// the detail-page assignment (§12.1 event 7, incl. the auto-follow).
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { adminNamespaceIds, bulkAssign } from "../store";
import { parseBulkAssignBody } from "../validation";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const admin = { userId: gate.user.id, roles: gate.user.roles };
  const adminNs = adminNamespaceIds(admin.roles);
  if (adminNs !== "all" && adminNs.length === 0) return Response.json({ error: "forbidden" }, { status: 403 });

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  const parsed = parseBulkAssignBody(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const outcomes = await bulkAssign(pool, admin, parsed.value.numbers, parsed.value.assigneeUserId, resolveRolesForUser);
  return Response.json({ outcomes });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/admin/triage/bulk-assign", handlePOST);

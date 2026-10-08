// POST /api/admin/triage/bulk-status (INNOBOX_SPEC.md §14.1): bulk admin status override
// over a selection — each item audited individually, exactly like a single-row override.
import { isChallengeStatus } from "@innobox/shared";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { adminNamespaceIds, bulkSetStatus } from "../store";
import { parseBulkStatusBody } from "../validation";
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
  const parsed = parseBulkStatusBody(body, isChallengeStatus);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const outcomes = await bulkSetStatus(pool, admin, parsed.value.numbers, parsed.value.status);
  return Response.json({ outcomes });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/admin/triage/bulk-status", handlePOST);

// POST /api/admin/triage/bulk-status (INNOBOX_SPEC.md §14.1): bulk admin status override
// over a selection — each item audited individually, exactly like a single-row override.
import { isChallengeStatus } from "@innobox/shared";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { adminNamespaceIds, bulkSetStatus } from "../store";
import { parseBulkStatusBody } from "../validation";

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
  const parsed = parseBulkStatusBody(body, isChallengeStatus);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const outcomes = await bulkSetStatus(pool, admin, parsed.value.numbers, parsed.value.status);
  return Response.json({ outcomes });
}

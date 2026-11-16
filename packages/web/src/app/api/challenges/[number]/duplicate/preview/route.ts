// GET /api/challenges/:number/duplicate/preview?original= (INNOBOX_SPEC.md §42.3, §42.9): the mark
// dialog's dry run — the same checks and counts as the mark, writing nothing. A refused pick answers
// 200 `{ ok: false, message }` so the dialog shows it inline; a duplicate the caller may not mark
// answers like the mark would (404/403/409).
import { requireUser, resolveRolesForUsers } from "@/lib/auth";
import { pool } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { previewDuplicate } from "../../../duplicates";
import { duplicateRefusalResponse } from "../../../duplicate-responses";
import { isEntityNumber } from "../../../validation";

export const dynamic = "force-dynamic";

async function handleGET(req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "search");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "challenge not found" }, { status: 404 });

  const original = new URL(req.url).searchParams.get("original") ?? "";
  const result = await previewDuplicate(pool, { userId: gate.user.id, roles: gate.user.roles }, number, original, resolveRolesForUsers);
  if (result.status !== "ok") return duplicateRefusalResponse(result);
  return Response.json(result.preview);
}

export const GET = withSystemLog("/api/challenges/[number]/duplicate/preview", handleGET);

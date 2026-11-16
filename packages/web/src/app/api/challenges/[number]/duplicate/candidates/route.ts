// GET /api/challenges/:number/duplicate/candidates?q= (INNOBOX_SPEC.md §42.3, §42.9): the mark
// dialog's search over eligible originals only — up to 10 matching `q` (a number or title words), or
// up to 5 similar ones while `q` is empty. Same access as the mark (404/403/409); the search rate
// limit (§2.4). Numbers, titles, statuses and namespaces — never an author.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { duplicateCandidates } from "../../../duplicates";
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

  const q = new URL(req.url).searchParams.get("q") ?? "";
  const result = await duplicateCandidates(pool, { userId: gate.user.id, roles: gate.user.roles }, number, q);
  if (result.status !== "ok") return duplicateRefusalResponse(result);
  return Response.json({ similar: result.similar, candidates: result.candidates });
}

export const GET = withSystemLog("/api/challenges/[number]/duplicate/candidates", handleGET);

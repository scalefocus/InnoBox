// POST /api/challenges/similar (INNOBOX_SPEC.md §6.1): the duplicate warning's similarity check.
// Ranks the caller's VISIBLE challenges against the title + description they are about to submit
// and returns at most five, authors masked. Advisory only — it never blocks a submission, and it
// shares the search rate limit (§2.4).
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { findSimilarChallenges } from "../store";
import { parseSimilarRequest } from "../validation";
import { readJsonObject } from "@/lib/http";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "search");
  if (limited) return limited;

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  const parsed = parseSimilarRequest(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const similar = await findSimilarChallenges(pool, { userId: gate.user.id, roles: gate.user.roles }, parsed.value);
  return Response.json({ similar });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/challenges/similar", handlePOST);

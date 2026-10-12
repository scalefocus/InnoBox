// POST /api/challenges/similar (INNOBOX_SPEC.md §6.1): the duplicate warning's similarity check.
// Ranks the caller's VISIBLE challenges against the title + description they are about to submit
// and returns at most five, authors masked. Advisory only — it never blocks a submission, and it
// shares the search rate limit (§2.4).
//
// §22.12: when "Explain similar challenges" is on and AI is available, the matches are re-ranked
// and each gets a one-line `reason` (`explainedBy` names the AI). Closed over the §6.1 set and
// silent on any failure or after 5 s — the plain list is always a valid answer.
import { aiDisplayName } from "@innobox/shared/ai";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { webAi } from "@/lib/ai";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { findSimilarChallengeCandidates } from "../store";
import { parseSimilarRequest } from "../validation";
import { readJsonObject } from "@/lib/http";
import { explainSimilar } from "../../ai/similar";
import { getAiDisplayNameSetting } from "../../admin/ai/store";

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

  const candidates = await findSimilarChallengeCandidates(pool, { userId: gate.user.id, roles: gate.user.roles }, parsed.value);
  const { similar, explained } = await explainSimilar(pool, webAi(), gate.user.id, parsed.value, candidates);
  return Response.json(explained ? { similar, explainedBy: aiDisplayName(await getAiDisplayNameSetting(pool)) } : { similar });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/challenges/similar", handlePOST);

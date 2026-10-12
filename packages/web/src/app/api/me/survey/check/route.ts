// POST /api/me/survey/check { canShow } → { survey } (INNOBOX_SPEC.md §13.10): the 90-day
// fallback for long-time users. AppShell calls it once per full page load, after its What's new
// decision, only when `canShow` is true and no offer is open. Same privacy treatment as every
// survey route: unaudited, anonymous system-log row and rate-limit warning, presence-silent.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { isSurveyWinForced } from "@/lib/survey-dev";
import { withSystemLog } from "@/lib/system-log";
import { checkSurveyFallback, cryptoRng } from "../store";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation", { anonymous: true });
  if (limited) return limited;

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const result = await checkSurveyFallback(pool, gate.user.id, read.value.canShow === true, {
    rng: cryptoRng,
    forceWin: isSurveyWinForced(gate.user.id),
  });
  return Response.json(result);
}

export const POST = withSystemLog("/api/me/survey/check", handlePOST, { anonymousActor: true });

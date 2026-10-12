// POST /api/me/survey/start → { survey, created } (INNOBOX_SPEC.md §13.10): the on-demand survey
// ("Give feedback", "Have your say"). Returns an open offer as is; otherwise opens a `self` offer and
// stamps the 7-day cooldown. 409 `surveys_off` / 409 `cooldown` `{ nextAt }`. The `survey`
// rate-limit bucket. Unaudited, anonymous in the system log and the rate-limit warning,
// presence-silent — like every survey route.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { cryptoRng, startSelfSurvey } from "../store";

export const dynamic = "force-dynamic";

async function handlePOST(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "survey", { anonymous: true });
  if (limited) return limited;

  const result = await startSelfSurvey(pool, gate.user.id, { rng: cryptoRng });
  switch (result.status) {
    case "ok":
      return Response.json({ survey: result.survey, created: result.created });
    case "cooldown":
      return Response.json({ error: "cooldown", nextAt: result.nextAt }, { status: 409 });
    case "surveys_off":
      return Response.json({ error: "surveys_off" }, { status: 409 });
    case "unavailable":
      return Response.json({ error: "unavailable" }, { status: 409 });
  }
}

export const POST = withSystemLog("/api/me/survey/start", handlePOST, { anonymousActor: true });

// POST /api/me/survey/close → { ok } (INNOBOX_SPEC.md §13.10): "not now". The offer stays open
// (Take the survey); the first close of a random offer counts once in the funnel. 409
// `no_open_survey` when nothing is open. Unaudited, anonymous in the system log, presence-silent.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { closeSurvey } from "../store";

export const dynamic = "force-dynamic";

async function handlePOST(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation", { anonymous: true });
  if (limited) return limited;

  const result = await closeSurvey(pool, gate.user.id);
  if (result === "no_open_survey") return Response.json({ error: "no_open_survey" }, { status: 409 });
  return Response.json({ ok: true });
}

export const POST = withSystemLog("/api/me/survey/close", handlePOST, { anonymousActor: true });

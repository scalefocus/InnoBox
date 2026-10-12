// POST /api/me/survey/responses { answers, freeText?, via, feature? } → { ok } (INNOBOX_SPEC.md
// §13.10). Stored in one transaction with NO reference to the author — the response row has no
// user column and only the UTC date. 409 `no_open_survey` when the offer has ended, 422 on
// validation. The `survey` rate-limit bucket. Unaudited, anonymous in the system log and the
// rate-limit warning, presence-silent.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { submitSurvey } from "../store";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "survey", { anonymous: true });
  if (limited) return limited;

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const result = await submitSurvey(pool, { id: gate.user.id, roles: gate.user.roles }, read.value);
  if (result.status === "no_open_survey") return Response.json({ error: "no_open_survey" }, { status: 409 });
  if (result.status === "invalid") return Response.json({ error: result.error }, { status: 422 });
  return Response.json({ ok: true });
}

export const POST = withSystemLog("/api/me/survey/responses", handlePOST, { anonymousActor: true });

// POST /api/me/features/used { feature, canShow } → { firstUse, survey } (INNOBOX_SPEC.md §13.10).
// The browser reports a catalog feature's defining action AFTER it succeeds — only the feature
// key, never an item id. A fresh first use, while eligible and `canShow`, rolls 1 in 3 server-side
// and, on a win, opens the survey offer.
//
// Survey privacy: no audit row; the §14.7 system-log row of a refusal carries no user id and no
// actor snapshot; the rate-limit warning omits the user id; and the route is silent for presence
// (it is not on the lib/presence.ts allowlist).
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { isSurveyWinForced } from "@/lib/survey-dev";
import { withSystemLog } from "@/lib/system-log";
import { isSurveyFeature } from "@innobox/shared/survey";
import { cryptoRng, recordFeatureUse } from "../../survey/store";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation", { anonymous: true });
  if (limited) return limited;

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const { feature, canShow } = read.value;
  if (!isSurveyFeature(feature)) return Response.json({ error: "unknown feature" }, { status: 422 });

  const result = await recordFeatureUse(pool, gate.user.id, feature, canShow === true, {
    rng: cryptoRng,
    forceWin: isSurveyWinForced(gate.user.id),
  });
  return Response.json(result);
}

export const POST = withSystemLog("/api/me/features/used", handlePOST, { anonymousActor: true });

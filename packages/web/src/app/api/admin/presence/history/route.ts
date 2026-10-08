// GET /api/admin/presence/history?range=7d|30d|90d|all (INNOBOX_SPEC.md §14.5): the
// active-users chart series — one point per UTC day. Platform admin only, like the panel it
// feeds.
//
// NOT audited, unlike the online list next to it: this response is a count per day carrying
// no user ids at all (`presence_daily` is aggregate by design), so it discloses nothing about
// any individual and is not the access §14.5's audit exists to record.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { MIN_CHART_POINTS, parsePresenceRange } from "@/lib/presence";
import { presenceHistory } from "../store";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;

  const range = parsePresenceRange(new URL(req.url).searchParams.get("range"));
  const points = await presenceHistory(pool, range);

  // There is no backfill — the series begins the day tracking shipped (§14.5). The client
  // renders the "not enough history yet" note instead of a chart while this is true.
  return Response.json({ range, points, enoughHistory: points.length >= MIN_CHART_POINTS });
}

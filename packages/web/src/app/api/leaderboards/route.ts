// GET /api/leaderboards (INNOBOX_SPEC.md §13.3): top 10 for a metric/window pair. Defaults
// to solutions_implemented / all, per spec ("solutions implemented (default)"). Auth-required;
// no visibility gate beyond the store's own org-visible/non-anonymous/non-rejected filter —
// leaderboard entries never leak namespace-restricted or anonymous contributions to anyone.
import { isLeaderboardMetric, isLeaderboardWindow, type LeaderboardMetric, type LeaderboardWindow } from "@innobox/shared";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getLeaderboard } from "./store";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const metricRaw = url.searchParams.get("metric") ?? "solutions_implemented";
  const windowRaw = url.searchParams.get("window") ?? "all";
  if (!isLeaderboardMetric(metricRaw)) {
    return Response.json({ error: "metric must be one of the documented leaderboard metrics" }, { status: 400 });
  }
  if (!isLeaderboardWindow(windowRaw)) {
    return Response.json({ error: "window must be '30d' or 'all'" }, { status: 400 });
  }
  const metric: LeaderboardMetric = metricRaw;
  const window: LeaderboardWindow = windowRaw;

  const entries = await getLeaderboard(pool, metric, window);
  return Response.json({ metric, window, entries });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/leaderboards", handleGET);

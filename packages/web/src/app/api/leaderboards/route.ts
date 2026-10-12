// GET /api/leaderboards (INNOBOX_SPEC.md §13.3): top 10 for a metric/window pair. Defaults
// to solutions_implemented / all, per spec ("solutions implemented (default)"). Auth-required;
// no visibility gate beyond the store's own org-visible/non-anonymous/non-rejected filter —
// leaderboard entries never leak namespace-restricted or anonymous contributions to anyone.
import { isLeaderboardMetric, isLeaderboardWindow, type LeaderboardMetric, type LeaderboardWindow } from "@innobox/shared";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getCachedLeaderboard } from "./store";
import { isGamificationOn, levelChips } from "@/lib/gamification-read";
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

  // §23: the Points metric exists only while gamification is on.
  const gamificationOn = await isGamificationOn(pool);
  if (metric === "points" && !gamificationOn) {
    return Response.json({ error: "metric must be one of the documented leaderboard metrics" }, { status: 400 });
  }

  const ranked = await getCachedLeaderboard(pool, metric, window);
  // §23.6: every row carries the user's level chip — null when they hide it or the feature is off.
  const chips = await levelChips(pool, ranked.map((e) => e.userId));
  const entries = ranked.map((e) => ({ ...e, level: chips.get(e.userId)?.level ?? null, progress: chips.get(e.userId)?.progress ?? null }));
  return Response.json({ metric, window, entries, gamification: gamificationOn });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/leaderboards", handleGET);

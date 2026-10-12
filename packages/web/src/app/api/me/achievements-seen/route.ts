// POST /api/me/achievements-seen (INNOBOX_SPEC.md §23.7): advances the achievement-toast marker
// after the app shell has shown the toast, so the same badges and levels are not celebrated twice.
// Seeing the toast does not mark the inbox row read. Own-account display marker: not audited, and
// silent for presence (lib/presence.ts lists no /api/me path).
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { markAchievementsSeen } from "@/lib/gamification-read";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handlePOST(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;

  await markAchievementsSeen(pool, gate.user.id);
  return Response.json({ seen: true });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/me/achievements-seen", handlePOST);

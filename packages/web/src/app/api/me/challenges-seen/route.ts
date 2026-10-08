// POST /api/me/challenges-seen (INNOBOX_SPEC.md §13.1): the app shell calls this when the user
// LEAVES the Challenges surface, stamping challenges_seen_at = now() so the nav bubble and the
// "new" card tags reset until newer challenges arrive. Own-account housekeeping — not audited.
// Also the target of a `sendBeacon` on page hide, so it tolerates an empty body.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { markChallengesSeen } from "../store";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

async function handlePOST(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  await markChallengesSeen(pool, gate.user.id);
  return Response.json({ ok: true });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/me/challenges-seen", handlePOST);

// GET /api/challenges/new-count (INNOBOX_SPEC.md §13.1): how many challenges, visible to the
// caller, were created since they last left the Challenges surface. A bare integer — no titles,
// no namespaces — polled by the app shell on the bell's 30-second cadence for the nav bubble.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { countNewChallenges } from "../store";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const count = await countNewChallenges(pool, { userId: gate.user.id, roles: gate.user.roles });
  return Response.json({ count });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/challenges/new-count", handleGET);

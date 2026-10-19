// POST /api/me/sign-out-everywhere ("Sign out everywhere", INNOBOX_SPEC.md §3): the account
// menu's last item. Stamps `users.sessions_valid_from = now()` for the signed-in user — every
// token minted before it, on every device, is no session from its next request (lib/auth.ts) —
// and audits `user.signed_out_everywhere` with the user as both actor and target. Answers 204;
// the client then runs the ordinary per-device sign-out for this browser. No body is read.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { signOutEverywhere } from "./store";

export const dynamic = "force-dynamic";

async function handlePOST(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;

  await signOutEverywhere(pool, gate.user.id);
  return new Response(null, { status: 204 });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/me/sign-out-everywhere", handlePOST);

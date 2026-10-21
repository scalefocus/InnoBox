// GET /api/me/pulse (INNOBOX_SPEC.md §12.2, v1.18): the app shell's only poll — the bell's unread
// count, the §13.1 new-challenges count, the §14.4 triage attention count (null for non-admins) and
// the active §14.6 system banner, in one round trip. A background poller: it is not on the §14.5
// presence allowlist, so it never stamps last_seen_at.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { readPulse } from "./store";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const pulse = await readPulse(pool, { userId: gate.user.id, roles: gate.user.roles });
  return Response.json(pulse, { headers: { "Cache-Control": "no-store" } });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/me/pulse", handleGET);

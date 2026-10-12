// GET /api/ai/triage/:number (INNOBOX_SPEC.md §22.11): a challenge's triage note for the caller —
// admins of its namespace always, its committee and assignee once past awaiting_triage, never its
// author. 404 for anyone else (and when there is nothing to show), so a note never leaks.
import { aiDisplayName } from "@innobox/shared/ai";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { webAi } from "@/lib/ai";
import { withSystemLog } from "@/lib/system-log";
import { getAiDisplayNameSetting } from "../../../admin/ai/store";
import { getTriageNotes } from "../store";

export const dynamic = "force-dynamic";

const NOT_FOUND = "triage notes not found";

async function handleGET(_req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { number } = await context.params;
  const digits = number.replace(/^CH-/i, "");
  if (!/^[1-9][0-9]{0,9}$/.test(digits)) return Response.json({ error: NOT_FOUND }, { status: 404 });
  const view = await getTriageNotes(pool, webAi(), { userId: gate.user.id, roles: gate.user.roles }, digits);
  if (!view) return Response.json({ error: NOT_FOUND }, { status: 404 });
  return Response.json({ ...view, displayName: aiDisplayName(await getAiDisplayNameSetting(pool)) });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/ai/triage/[number]", handleGET);

// POST /api/admin/email/test-send (INNOBOX_SPEC.md §12.1): sends a test notification to the
// acting admin's own address through the connected Graph service account. Platform-admin
// only; unaudited (it mails only the actor, not a notification event).
import { requirePlatformAdmin } from "@/lib/auth";
import { sendTestEmail } from "@/lib/email";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

async function handlePOST(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;

  const result = await sendTestEmail(gate.user.id);
  if ("error" in result) return Response.json({ error: result.error }, { status: 400 });
  return Response.json(result);
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/admin/email/test-send", handlePOST);

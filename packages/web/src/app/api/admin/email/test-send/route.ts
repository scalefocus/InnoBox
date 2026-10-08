// POST /api/admin/email/test-send (INNOBOX_SPEC.md §12.1): sends a test notification to the
// acting admin's own address through the connected Graph service account. Platform-admin
// only; unaudited (it mails only the actor, not a notification event).
import { requirePlatformAdmin } from "@/lib/auth";
import { sendTestEmail } from "@/lib/email";

export async function POST(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;

  const result = await sendTestEmail(gate.user.id);
  if ("error" in result) return Response.json({ error: result.error }, { status: 400 });
  return Response.json(result);
}

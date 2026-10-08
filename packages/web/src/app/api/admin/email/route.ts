// GET /api/admin/email (INNOBOX_SPEC.md §12.1, §14.3): the notification sender's connection
// status (connected account, refresh health, wrapper presence, operational pill). Platform-
// admin only.
import { requirePlatformAdmin } from "@/lib/auth";
import { getEmailChannelStatus } from "@/lib/email";

export async function GET(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const status = await getEmailChannelStatus();
  return Response.json({ status });
}

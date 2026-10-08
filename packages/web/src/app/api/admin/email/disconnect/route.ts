// POST /api/admin/email/disconnect (INNOBOX_SPEC.md §12.1): hard-deletes the connected
// service account row (tokens destroyed). Platform-admin only; audited.
import { requirePlatformAdmin } from "@/lib/auth";
import { disconnectEmail } from "@/lib/email";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

async function handlePOST(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const disconnectedUpn = await disconnectEmail(gate.user.id);
  return Response.json({ disconnectedUpn });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/admin/email/disconnect", handlePOST);

// POST /api/admin/email/disconnect (INNOBOX_SPEC.md §12.1): hard-deletes the connected
// service account row (tokens destroyed). Platform-admin only; audited.
import { requirePlatformAdmin } from "@/lib/auth";
import { disconnectEmail } from "@/lib/email";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const disconnectedUpn = await disconnectEmail(gate.user.id);
  return Response.json({ disconnectedUpn });
}

// DELETE /api/admin/innovation-board/members/:userId (INNOBOX_SPEC.md §45.2, §45.10): take one
// person off the innovation board — 204, or 404 when they are not on it. Their early read access
// ends with their next request, and nothing is sent to them (a removal is silent, §45.6).
// Platform admin only; audited as `innovation_board.member_removed`.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { isUuid } from "../../../../challenges/validation";
import { removeBoardMember } from "../../store";

export const dynamic = "force-dynamic";

const NOT_ON_BOARD = "This person is not on the innovation board.";

async function handleDELETE(_req: Request, context: { params: Promise<{ userId: string }> }): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { userId } = await context.params;
  if (!isUuid(userId)) return Response.json({ error: NOT_ON_BOARD }, { status: 404 });

  const result = await removeBoardMember(pool, gate.user.id, userId.toLowerCase());
  if (result === "not_found") return Response.json({ error: NOT_ON_BOARD }, { status: 404 });
  return new Response(null, { status: 204 });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const DELETE = withSystemLog("/api/admin/innovation-board/members/[userId]", handleDELETE);

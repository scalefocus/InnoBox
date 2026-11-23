// GET /api/admin/innovation-board (INNOBOX_SPEC.md §45.2, §45.10): the roster for the Innovation
// board card on Platform settings — each member with who added them and when, and the cap.
// Platform admin only (403 otherwise): the roster is shown to nobody else (§45.7).
import { INNOVATION_BOARD_MAX } from "@innobox/shared";
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { listBoardMembers } from "./store";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  return Response.json({ max: INNOVATION_BOARD_MAX, members: await listBoardMembers(pool) });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/innovation-board", handleGET);

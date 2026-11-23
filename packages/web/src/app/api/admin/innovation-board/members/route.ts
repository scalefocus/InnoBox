// POST /api/admin/innovation-board/members (INNOBOX_SPEC.md §45.2, §45.10): `{ userIds }` — add 1 to
// 20 people to the innovation board, all-or-nothing. 400 for a malformed body, 422 for an unknown,
// inactive or erased person, 409 over the cap of 100; a person already on the board is skipped.
// After commit each person actually added is told once (§12.1 event 28) — never the acting admin.
// Platform admin only; audited as `innovation_board.member_added`, one row per person.
import { BOARD_FULL, BOARD_INELIGIBLE, validateBoardUserIds } from "@innobox/shared";
import { requirePlatformAdmin, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { logNotifyFailure, notifyBoardMembersAdded } from "@/lib/notify-events";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { addBoardMembers } from "../store";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const userIds = validateBoardUserIds(read.value.userIds);
  if (!userIds.ok) return Response.json({ error: userIds.error }, { status: 400 });

  const result = await addBoardMembers(pool, gate.user.id, userIds.value);
  switch (result.status) {
    case "ok":
      // After commit: a failed notice never undoes a completed add.
      await notifyBoardMembersAdded({ pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser }, result.added).catch(
        logNotifyFailure("innovation board add notification failed"),
      );
      return Response.json({ added: result.added });
    case "ineligible":
      return Response.json({ error: BOARD_INELIGIBLE }, { status: 422 });
    case "full":
      return Response.json({ error: BOARD_FULL }, { status: 409 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/admin/innovation-board/members", handlePOST);

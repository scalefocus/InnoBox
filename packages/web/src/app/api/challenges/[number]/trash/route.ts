// POST /api/challenges/:number/trash (INNOBOX_SPEC.md §10.4): Move to trash — the danger zone's
// primary action. Body `{ reason }` (required, ≤ 500). The challenge and every solution under it
// drop out of every surface at once and are purged after 30 days unless restored. Platform admins
// only: anyone else gets the same 404 as a missing challenge, BEFORE the body is looked at (a 422
// for a missing reason would confirm the endpoint is live for them). Silent — no notification.
import { validateTrashReason } from "@innobox/shared";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";
import { withSystemLog } from "@/lib/system-log";
import { trashChallenge } from "../../trash";
import { isEntityNumber } from "../../validation";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number) || !gate.user.roles.isPlatformAdmin) return Response.json({ error: "challenge not found" }, { status: 404 });

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const reason = validateTrashReason(read.value.reason);
  if (!reason.ok) return Response.json({ error: reason.error }, { status: 422 });

  const result = await trashChallenge({ pool, storage: getStorage() }, { userId: gate.user.id, roles: gate.user.roles }, number, reason.value);
  switch (result.status) {
    case "ok":
      return Response.json({ trashed: true });
    case "not_found":
      return Response.json({ error: "challenge not found" }, { status: 404 });
    case "already_trashed":
      return Response.json({ error: "This challenge is already in the trash." }, { status: 409 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/challenges/[number]/trash", handlePOST);

// POST /api/solutions/:number/trash (INNOBOX_SPEC.md §10.4): Move one solution to the trash; its
// challenge stays. Body `{ reason }` (required, ≤ 500). Platform admins only — 404 to anyone else,
// before the body is read. 409 when it (or its challenge) is already in the trash. Silent.
import { validateTrashReason } from "@innobox/shared";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";
import { withSystemLog } from "@/lib/system-log";
import { trashSolution } from "../../../challenges/trash";
import { isEntityNumber } from "../../../challenges/validation";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number) || !gate.user.roles.isPlatformAdmin) return Response.json({ error: "solution not found" }, { status: 404 });

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const reason = validateTrashReason(read.value.reason);
  if (!reason.ok) return Response.json({ error: reason.error }, { status: 422 });

  const result = await trashSolution({ pool, storage: getStorage() }, { userId: gate.user.id, roles: gate.user.roles }, number, reason.value);
  switch (result.status) {
    case "ok":
      return Response.json({ trashed: true });
    case "not_found":
      return Response.json({ error: "solution not found" }, { status: 404 });
    case "already_trashed":
      return Response.json({ error: "This solution is already in the trash." }, { status: 409 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/solutions/[number]/trash", handlePOST);

// POST /api/solutions/:number/restore (INNOBOX_SPEC.md §10.4): bring one solution back from the
// trash exactly as it was. Platform admins only (404 to anyone else). 409 when it is not in the
// trash, or while its challenge still is ("Restore the challenge first."). Silent.
import { RESTORE_CHALLENGE_FIRST } from "@innobox/shared";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { restoreSolution } from "../../../challenges/trash";
import { isEntityNumber } from "../../../challenges/validation";

export const dynamic = "force-dynamic";

async function handlePOST(_req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "solution not found" }, { status: 404 });

  const result = await restoreSolution(pool, { userId: gate.user.id, roles: gate.user.roles }, number);
  switch (result.status) {
    case "ok":
      return Response.json({ restored: true });
    case "not_found":
      return Response.json({ error: "solution not found" }, { status: 404 });
    case "not_trashed":
      return Response.json({ error: "This solution is not in the trash." }, { status: 409 });
    case "parent_trashed":
      return Response.json({ error: RESTORE_CHALLENGE_FIRST }, { status: 409 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/solutions/[number]/restore", handlePOST);

// POST /api/challenges/:number/restore (INNOBOX_SPEC.md §10.4): bring a challenge back from the
// trash exactly as it was, with every solution that was not trashed on its own. Platform admins
// only (404 to anyone else). 409 when it is not in the trash. Silent — no notification.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { restoreChallenge } from "../../trash";
import { isEntityNumber } from "../../validation";

export const dynamic = "force-dynamic";

async function handlePOST(_req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "challenge not found" }, { status: 404 });

  const result = await restoreChallenge(pool, { userId: gate.user.id, roles: gate.user.roles }, number);
  switch (result.status) {
    case "ok":
      return Response.json({ restored: true });
    case "not_found":
      return Response.json({ error: "challenge not found" }, { status: 404 });
    case "not_trashed":
      return Response.json({ error: "This challenge is not in the trash." }, { status: 409 });
    case "parent_trashed": // a challenge has no parent; kept for the shared result type
      return Response.json({ error: "This challenge is not in the trash." }, { status: 409 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/challenges/[number]/restore", handlePOST);

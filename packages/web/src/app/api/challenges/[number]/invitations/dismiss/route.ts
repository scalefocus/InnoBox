// POST /api/challenges/:number/invitations/dismiss (INNOBOX_SPEC.md §40.3, §40.11): the invitee's
// quiet "Not for me". 404 when the number is malformed or the caller cannot see the challenge; the
// shared 409 on a trashed one; 409 when the caller holds no invitation to it. A repeat succeeds and
// writes nothing new. Tells nobody, so nothing is dispatched.
import { INVITATION_MESSAGES } from "@innobox/shared";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { trashedResponse } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { isEntityNumber } from "../../../validation";
import { dismissInvitations } from "../../../invitations";

export const dynamic = "force-dynamic";

async function handlePOST(_req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "challenge not found" }, { status: 404 });

  const result = await dismissInvitations(pool, { userId: gate.user.id, roles: gate.user.roles }, number);
  switch (result.status) {
    case "ok":
      return Response.json({ dismissed: true });
    case "not_found":
      return Response.json({ error: "challenge not found" }, { status: 404 });
    case "trashed":
      return trashedResponse();
    case "no_invitation":
      return Response.json({ error: INVITATION_MESSAGES.noInvitation, code: "no_invitation" }, { status: 409 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/challenges/[number]/invitations/dismiss", handlePOST);

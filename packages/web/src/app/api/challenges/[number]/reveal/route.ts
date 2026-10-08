// POST /api/challenges/:number/reveal (INNOBOX_SPEC.md §9): admin transient reveal — the
// real author name is returned once for this admin's view, never persisted, always audited.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { revealChallengeAuthor } from "../../store";
import { rateLimit } from "@/lib/rate-limit";
import { isEntityNumber } from "../../validation";
import { withSystemLog } from "@/lib/system-log";

async function handlePOST(_req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "challenge not found" }, { status: 404 });

  const result = await revealChallengeAuthor(pool, { userId: gate.user.id, roles: gate.user.roles }, number);
  switch (result.status) {
    case "ok":
      return Response.json({ displayName: result.realDisplayName, email: result.realEmail, userId: result.realUserId });
    case "not_found":
      return Response.json({ error: "challenge not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: "you must be a namespace or platform admin to reveal" }, { status: 403 });
    case "not_anonymous":
      return Response.json({ error: "this challenge is not anonymous" }, { status: 400 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/challenges/[number]/reveal", handlePOST);

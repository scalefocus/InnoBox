// POST /api/challenges/:number/visibility (INNOBOX_SPEC.md §4.3, §14.2): a namespace/platform
// admin changes a challenge's visibility (org ↔ namespace) after submission. Audited as
// `challenge.visibility_changed` (§15). Solutions/comments/likes inherit the new visibility.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { setChallengeVisibility } from "../../store";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { isEntityNumber } from "../../validation";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "challenge not found" }, { status: 404 });

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  const visibility = body.visibility;
  if (typeof visibility !== "string") return Response.json({ error: "visibility is required" }, { status: 400 });

  const result = await setChallengeVisibility(pool, { userId: gate.user.id, roles: gate.user.roles }, number, visibility);
  switch (result.status) {
    case "ok":
      return Response.json({ challenge: result.challenge });
    case "not_found":
      return Response.json({ error: "challenge not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: "you must be a namespace or platform admin to change visibility" }, { status: 403 });
    case "invalid":
      return Response.json({ error: "visibility must be 'org' or 'namespace'" }, { status: 400 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/challenges/[number]/visibility", handlePOST);

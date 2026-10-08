// POST /api/admin/users/:userId/scrub (INNOBOX_SPEC.md §3, §16): the platform-admin GDPR erasure
// ("Delete user info") action. De-identifies the user's row and all their content; irreversible.
// The audit_log is exempt from erasure (§15) — this action is itself audited as user.scrubbed.
// Body `{ reassignTo?: uuid | null }` (an empty body or `{}` = no successor): the open
// assignments the successor can see move to them in the same transaction, and the successor
// gets one summary notification after commit (§12.1 event 12).
import { requirePlatformAdmin, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { scrubUser } from "../../../../users/store";
import { parseScrubRequest } from "../../../../users/erasure-validation";
import { notifyAssignmentsTransferred } from "../../../../users/erasure-reassignment";
import { readJsonObject, type BodyResult } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { isUuid } from "../../../../challenges/validation";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

/** §16: an empty body keeps the no-successor erasure (the pre-v0.10 client sent `{}`); any
 *  body that IS present goes through the §2.4 JSON-object reader. */
async function readScrubBody(req: Request): Promise<BodyResult<Record<string, unknown>>> {
  if (!req.body || req.headers.get("content-length") === "0") return { ok: true, value: {} };
  return readJsonObject(req);
}

async function handlePOST(req: Request, context: { params: Promise<{ userId: string }> }): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { userId } = await context.params;
  if (!isUuid(userId)) return Response.json({ error: "user not found" }, { status: 404 });

  const read = await readScrubBody(req);
  if (!read.ok) return read.response;
  const parsed = parseScrubRequest(read.value, userId.toLowerCase());
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const { reassignTo } = parsed.value;

  const result = await scrubUser(
    pool,
    gate.user.id,
    userId,
    reassignTo ? { successorId: reassignTo, resolveRoles: resolveRolesForUser } : undefined,
  );
  switch (result.status) {
    case "ok":
      if (result.reassignment) {
        // After commit: a failed notification never undoes a completed erasure.
        await notifyAssignmentsTransferred({ pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser }, result.reassignment).catch((err) =>
          console.error(JSON.stringify({ level: "error", msg: "assignments-transferred notification failed", error: String(err) })),
        );
      }
      return Response.json({ ok: true, reassignment: result.reassignment });
    case "not_found":
      return Response.json({ error: "user not found" }, { status: 404 });
    case "already_scrubbed":
      return Response.json({ error: "this user's info has already been deleted" }, { status: 409 });
    case "invalid_successor":
      return Response.json({ error: "open assignments can only be reassigned to an active user" }, { status: 400 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/admin/users/[userId]/scrub", handlePOST);

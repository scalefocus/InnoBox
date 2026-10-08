// POST /api/admin/users/:userId/scrub (INNOBOX_SPEC.md §3): the platform-admin GDPR erasure
// ("Delete user info") action. De-identifies the user's row and all their content; irreversible.
// The audit_log is exempt from erasure (§15) — this action is itself audited as user.scrubbed.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { scrubUser } from "../../../../users/store";
import { rateLimit } from "@/lib/rate-limit";
import { isUuid } from "../../../../challenges/validation";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, context: { params: Promise<{ userId: string }> }): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { userId } = await context.params;
  if (!isUuid(userId)) return Response.json({ error: "user not found" }, { status: 404 });

  const result = await scrubUser(pool, gate.user.id, userId);
  switch (result.status) {
    case "ok":
      return Response.json({ ok: true });
    case "not_found":
      return Response.json({ error: "user not found" }, { status: 404 });
    case "already_scrubbed":
      return Response.json({ error: "this user's info has already been deleted" }, { status: 409 });
  }
}

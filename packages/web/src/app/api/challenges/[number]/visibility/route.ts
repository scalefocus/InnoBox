// POST /api/challenges/:number/visibility (INNOBOX_SPEC.md §4.3, §14.2): a namespace/platform
// admin changes a challenge's visibility (org ↔ namespace) after submission. Audited as
// `challenge.visibility_changed` (§15). Solutions/comments/likes inherit the new visibility.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { setChallengeVisibility } from "../../store";

export const dynamic = "force-dynamic";

export async function POST(req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { number } = await context.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const visibility = (body as Record<string, unknown>)?.visibility;
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

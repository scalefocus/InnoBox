// POST /api/challenges/:number/reveal (INNOBOX_SPEC.md §9): admin transient reveal — the
// real author name is returned once for this admin's view, never persisted, always audited.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { revealChallengeAuthor } from "../../store";

export async function POST(_req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { number } = await context.params;

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

// POST /api/solutions/:number/self-reveal (INNOBOX_SPEC.md §9): the author permanently
// removes their own anonymity (one-way, audited).
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { selfRevealSolution } from "../../../challenges/store";
import { rateLimit } from "@/lib/rate-limit";
import { isEntityNumber } from "../../../challenges/validation";

export async function POST(_req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "solution not found" }, { status: 404 });

  const result = await selfRevealSolution(pool, { userId: gate.user.id, roles: gate.user.roles }, number);
  switch (result.status) {
    case "ok":
      return new Response(null, { status: 204 });
    case "not_found":
      return Response.json({ error: "solution not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: "only the author can reveal their own anonymity" }, { status: 403 });
    case "not_anonymous":
      return Response.json({ error: "this solution is not anonymous" }, { status: 400 });
  }
}

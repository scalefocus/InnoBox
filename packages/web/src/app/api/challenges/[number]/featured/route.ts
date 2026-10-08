// PUT/DELETE /api/challenges/:number/featured (INNOBOX_SPEC.md §13.2 *Featured challenges*,
// §16): a platform admin pins / unpins a challenge on the Home dashboard. No body. Order of
// checks (§2.4): 404 (malformed or invisible) → 403 (not a platform admin) → 409 (ineligible
// status, PUT only) → 409 (at the cap). Success: `{ featured, featuredAt }`. Audited, silent.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { featureChallenge, unfeatureChallenge, type FeatureResult } from "../../featured";
import { FEATURE_FORBIDDEN_MESSAGE, FEATURE_INELIGIBLE_MESSAGE, featuredCapMessage } from "../../featured-rules";
import { isEntityNumber } from "../../validation";

export const dynamic = "force-dynamic";

function toResponse(result: FeatureResult): Response {
  switch (result.status) {
    case "ok":
      return Response.json({ featured: result.featured, featuredAt: result.featuredAt });
    case "not_found":
      return Response.json({ error: "challenge not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: FEATURE_FORBIDDEN_MESSAGE }, { status: 403 });
    case "ineligible":
      return Response.json({ error: FEATURE_INELIGIBLE_MESSAGE }, { status: 409 });
    case "at_cap":
      return Response.json({ error: featuredCapMessage(result.limit) }, { status: 409 });
  }
}

async function handle(context: { params: Promise<{ number: string }> }, op: typeof featureChallenge): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "challenge not found" }, { status: 404 });
  return toResponse(await op(pool, { userId: gate.user.id, roles: gate.user.roles }, number));
}

async function handlePUT(_req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  return handle(context, featureChallenge);
}

async function handleDELETE(_req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  return handle(context, unfeatureChallenge);
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const PUT = withSystemLog("/api/challenges/[number]/featured", handlePUT);
export const DELETE = withSystemLog("/api/challenges/[number]/featured", handleDELETE);

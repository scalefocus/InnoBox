// POST /api/feature-ideas { description } (INNOBOX_SPEC.md §38.4, §38.14): a new feature idea,
// pending until a platform admin reviews it → 201 `{ id }`. 422 for an empty or over-long text, 409
// `too_many_pending` with 3 already waiting, 404 while feature ideas are off. The `feature_idea`
// limits: 2 a minute and 5 a day — the warning names the user, since a proposal is not anonymous.
import { FEATURE_IDEA_MESSAGES, getFeatureIdeasEnabled, validateIdeaText } from "@innobox/shared";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { proposeIdea } from "./store";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  if (!(await getFeatureIdeasEnabled(pool))) return Response.json({ error: "not found" }, { status: 404 });
  const limited = rateLimit(gate.user.id, "feature_idea") ?? rateLimit(gate.user.id, "feature_idea_day");
  if (limited) return limited;

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const text = validateIdeaText(read.value.description);
  if (!text.ok) return Response.json({ error: text.error }, { status: 422 });
  const result = await proposeIdea(pool, gate.user.id, text.value);
  if (result.status === "too_many_pending") {
    return Response.json({ error: FEATURE_IDEA_MESSAGES.tooManyPending, code: "too_many_pending" }, { status: 409 });
  }
  return Response.json({ id: result.id }, { status: 201 });
}

export const POST = withSystemLog("/api/feature-ideas", handlePOST);

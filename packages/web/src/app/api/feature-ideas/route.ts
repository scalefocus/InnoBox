// POST /api/feature-ideas { title, description } (INNOBOX_SPEC.md §38.4, §38.14): a new feature idea,
// pending until a platform admin reviews it → 201 `{ id }`. 422 for an empty title or text, a title
// over 60 characters or holding a line break, or an over-long text. For
// everyone but platform admins: 404 while proposals are closed (§38.11), 409 `too_many_pending` with
// 3 already waiting, and the `feature_idea` limits — 2 a minute and 5 a day, the warning naming the
// user, since a proposal is not anonymous. A platform admin proposes to add to the roadmap and is
// exempt from all three.
import { FEATURE_IDEA_MESSAGES, canProposeFeature, getFeatureIdeasEnabled, validateIdeaText, validateIdeaTitle } from "@innobox/shared";
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
  const platformAdmin = gate.user.roles.isPlatformAdmin;
  if (!canProposeFeature(platformAdmin, await getFeatureIdeasEnabled(pool))) return Response.json({ error: "not found" }, { status: 404 });
  if (!platformAdmin) {
    const limited = rateLimit(gate.user.id, "feature_idea") ?? rateLimit(gate.user.id, "feature_idea_day");
    if (limited) return limited;
  }

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const title = validateIdeaTitle(read.value.title);
  if (!title.ok) return Response.json({ error: title.error }, { status: 422 });
  const text = validateIdeaText(read.value.description);
  if (!text.ok) return Response.json({ error: text.error }, { status: 422 });
  const result = await proposeIdea(pool, gate.user.id, { title: title.value, text: text.value }, { uncapped: platformAdmin });
  if (result.status === "too_many_pending") {
    return Response.json({ error: FEATURE_IDEA_MESSAGES.tooManyPending, code: "too_many_pending" }, { status: 409 });
  }
  return Response.json({ id: result.id }, { status: 201 });
}

export const POST = withSystemLog("/api/feature-ideas", handlePOST);

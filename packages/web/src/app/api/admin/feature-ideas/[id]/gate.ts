// Shared plumbing of the §38.5 review routes (INNOBOX_SPEC.md §38.14): the platform-admin gate, the
// mutation rate limit, the id check, the switch (every decision is refused while feature ideas are
// off — 409 `feature_ideas_off`), and the refusals every decision shares.
import { FEATURE_IDEA_MESSAGES, getFeatureIdeasEnabled } from "@innobox/shared";
import { requirePlatformAdmin, type SessionUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { isUuid } from "../../../challenges/validation";
import type { DeleteResult } from "../../../feature-ideas/store";

export type IdeaGate = { ok: true; user: SessionUser; id: string } | { ok: false; response: Response };

export async function ideaGate(context: { params: Promise<{ id: string }> }): Promise<IdeaGate> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return { ok: false, response: limited };
  const { id } = await context.params;
  if (!isUuid(id)) return { ok: false, response: Response.json({ error: FEATURE_IDEA_MESSAGES.notFound }, { status: 404 }) };
  if (!(await getFeatureIdeasEnabled(pool))) {
    return { ok: false, response: Response.json({ error: FEATURE_IDEA_MESSAGES.off, code: "feature_ideas_off" }, { status: 409 }) };
  }
  return { ok: true, user: gate.user, id };
}

/** The answer to a decision: `{ ok }`, or the refusal its status names. */
export function decisionResponse(result: DeleteResult): Response {
  switch (result.status) {
    case "ok":
      return Response.json({ ok: true });
    case "not_found":
      return Response.json({ error: FEATURE_IDEA_MESSAGES.notFound }, { status: 404 });
    case "conflict":
      return Response.json({ error: FEATURE_IDEA_MESSAGES.alreadyDecided, code: "already_decided" }, { status: 409 });
    case "not_visible":
      return Response.json({ error: `${FEATURE_IDEA_MESSAGES.notVisibleToProposer}.`, code: "not_visible" }, { status: 409 });
    case "bad_target":
      return Response.json({ error: "Choose an entry that is still in Coming soon.", code: "bad_target" }, { status: 400 });
    case "needs_choice":
      return Response.json({ error: "notifyShipped must be true or false for a planned idea" }, { status: 400 });
  }
}

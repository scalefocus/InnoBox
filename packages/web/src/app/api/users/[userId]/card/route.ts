// GET /api/users/:userId/card (INNOBOX_SPEC.md §13.8): the directory hover card's payload —
// display name plus the three directory-profile fields (job title, department, office location).
//
// Any authenticated user may read any user's card: InnoBox has no per-user visibility model
// (invariant 2 governs challenges, not people) and /api/profile/:userId already exposes the same
// fields to any signed-in caller. Not anonymity-sensitive for the same reason as the photo gateway
// (§3.1): the client only ever holds a real id for a NON-anonymous author, so no card can be
// fetched for an anonymous one (invariant 3).
//
// A malformed id is a 404, not a 500 — the uuid check keeps a bad path segment away from the
// Postgres cast. Single indexed primary-key lookup; no aggregate, no audit row (it is a read).
import { isUuid } from "../../../challenges/validation";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getUserCard } from "../../store";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(_req: Request, context: { params: Promise<{ userId: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const { userId } = await context.params;
  if (!isUuid(userId)) return Response.json({ error: "not found" }, { status: 404 });

  const card = await getUserCard(pool, userId);
  if (!card) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ card });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/users/[userId]/card", handleGET);

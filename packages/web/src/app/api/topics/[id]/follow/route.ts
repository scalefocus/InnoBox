// POST /api/topics/:id/follow (INNOBOX_SPEC.md §34.4, §34.9): `{ following: true | false }` sets the
// wanted state, so a repeated click is harmless. Any active topic can be followed and any topic
// unfollowed (409 for following a retired one, 404 for an unknown id). Silent — not audited, no
// notification, no points.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { isUuid } from "../../../challenges/validation";
import { setTopicFollow } from "../../store";

async function handlePOST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: "topic not found" }, { status: 404 });

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  if (typeof read.value.following !== "boolean") return Response.json({ error: "following must be true or false" }, { status: 400 });

  const result = await setTopicFollow(pool, gate.user.id, id.toLowerCase(), read.value.following);
  switch (result.status) {
    case "ok":
      return Response.json({ following: result.following });
    case "not_found":
      return Response.json({ error: "topic not found" }, { status: 404 });
    case "retired":
      return Response.json({ error: "This topic is retired and can't be followed." }, { status: 409 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/topics/[id]/follow", handlePOST);

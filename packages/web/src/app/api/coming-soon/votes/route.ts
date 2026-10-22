// POST /api/coming-soon/votes { entry } (INNOBOX_SPEC.md §38.3, §38.14): toggles the viewer's
// upvote on one Coming soon entry (`spec:<key>` or `idea:<uuid>`) and answers its new state —
// `{ voted, votes, voters, othersCount, othersIncludesYou }`. 404 while feature ideas are off, for a
// malformed id, and for an entry that is not live or does not apply to the viewer. Audited under All.
import { getFeatureIdeasEnabled, parseEntryId } from "@innobox/shared";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { toggleVote } from "../../feature-ideas/store";

export const dynamic = "force-dynamic";

const notFound = (): Response => Response.json({ error: "not found" }, { status: 404 });

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  if (!(await getFeatureIdeasEnabled(pool))) return notFound();

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const ref = parseEntryId(read.value.entry);
  if (!ref) return notFound();
  const result = await toggleVote(pool, { userId: gate.user.id, roles: gate.user.roles }, ref);
  if (result.status === "not_found") return notFound();
  return Response.json({
    voted: result.voted,
    votes: result.votes,
    voters: result.voters,
    othersCount: result.othersCount,
    othersIncludesYou: result.othersIncludesYou,
  });
}

export const POST = withSystemLog("/api/coming-soon/votes", handlePOST);

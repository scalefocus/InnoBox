// GET /api/coming-soon (INNOBOX_SPEC.md §13.9, §38.14): What's new's Coming soon entries — the
// planned rows that apply to the viewer, in the §38.2 order, each with its votes, the viewer's own
// vote, the named voters, the proposer and its approval time (for the page's re-sort, §38.3) — plus
// whether the viewer may propose (§38.11) and their pending count for the propose dialog. The page's
// only read for the section: on load and on every 30-second live refresh while the list is open.
import { getFeatureIdeasEnabled } from "@innobox/shared";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { getComingSoon } from "../feature-ideas/store";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const proposalsOpen = await getFeatureIdeasEnabled(pool);
  return Response.json(await getComingSoon(pool, { userId: gate.user.id, roles: gate.user.roles }, proposalsOpen));
}

export const GET = withSystemLog("/api/coming-soon", handleGET);

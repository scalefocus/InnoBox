// GET /api/coming-soon (INNOBOX_SPEC.md §13.9, §38.14): What's new's Coming soon entries — the
// specified teasers and the planned community ideas that apply to the viewer, in the §38.2 order,
// each with its votes, the viewer's own vote, the named voters and the proposer — plus the viewer's
// pending count for the propose dialog. While feature ideas are off: `{ enabled: false }` and the
// specified teasers alone, read-only, in hand order. The page's only read for the section.
import { getFeatureIdeasEnabled } from "@innobox/shared";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { getComingSoon } from "../feature-ideas/store";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const enabled = await getFeatureIdeasEnabled(pool);
  return Response.json(await getComingSoon(pool, { userId: gate.user.id, roles: gate.user.roles }, enabled));
}

export const GET = withSystemLog("/api/coming-soon", handleGET);

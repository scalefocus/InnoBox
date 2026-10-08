// GET /api/impact-areas (INNOBOX_SPEC.md §5): active impact areas for the challenge
// submission form. Management (add/rename/retire) is §14.3 platform settings, Phase 4.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { listActiveImpactAreas } from "../challenges/store";
import { withSystemLog } from "@/lib/system-log";

async function handleGET(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const impactAreas = await listActiveImpactAreas(pool);
  return Response.json({ impactAreas });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/impact-areas", handleGET);

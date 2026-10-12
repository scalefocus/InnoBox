// GET /api/profile/:userId (INNOBOX_SPEC.md §13.5): another user's public profile — display
// name, department, job title, and their non-anonymous org-visible contributions only.
import { isUuid } from "../../challenges/validation";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getPublicProfile } from "../store";
import { publicGamification } from "@/lib/gamification-read";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(_req: Request, { params }: { params: Promise<{ userId: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const { userId } = await params;
  if (!isUuid(userId)) return Response.json({ error: "not found" }, { status: 404 });

  const profile = await getPublicProfile(pool, userId);
  if (!profile) return Response.json({ error: "not found" }, { status: 404 });
  // §23.6: level, leader badges and earned badges — null when the feature is off or they hide it.
  return Response.json({ profile: { ...profile, gamification: await publicGamification(pool, userId) } });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/profile/[userId]", handleGET);

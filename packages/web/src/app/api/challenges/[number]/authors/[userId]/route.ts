// DELETE /api/challenges/:number/authors/:userId (INNOBOX_SPEC.md §39.13): a member removes another
// member, or — with their own id — leaves the challenge's team. See ../../../team-routes.ts.
import { withSystemLog } from "@/lib/system-log";
import { teamDELETE } from "../../../team-routes";

export const dynamic = "force-dynamic";

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const DELETE = withSystemLog("/api/challenges/[number]/authors/[userId]", teamDELETE("challenge"));

// DELETE /api/solutions/:number/authors/:userId (INNOBOX_SPEC.md §39.13): a member removes another
// member, or — with their own id — leaves the solution's team. See ../../../../challenges/team-routes.ts.
import { withSystemLog } from "@/lib/system-log";
import { teamDELETE } from "../../../../challenges/team-routes";

export const dynamic = "force-dynamic";

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const DELETE = withSystemLog("/api/solutions/[number]/authors/[userId]", teamDELETE("solution"));

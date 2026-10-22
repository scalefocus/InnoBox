// POST /api/solutions/:number/authors (INNOBOX_SPEC.md §39.13): a member adds a colleague to the
// solution's co-author team. See ../../../challenges/team-routes.ts.
import { withSystemLog } from "@/lib/system-log";
import { teamPOST } from "../../../challenges/team-routes";

export const dynamic = "force-dynamic";

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/solutions/[number]/authors", teamPOST("solution"));

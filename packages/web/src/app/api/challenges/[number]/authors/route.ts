// POST /api/challenges/:number/authors (INNOBOX_SPEC.md §39.13): a member adds a colleague to the
// challenge's co-author team. See ../../team-routes.ts.
import { withSystemLog } from "@/lib/system-log";
import { teamPOST } from "../../team-routes";

export const dynamic = "force-dynamic";

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/challenges/[number]/authors", teamPOST("challenge"));

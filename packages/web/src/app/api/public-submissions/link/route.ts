// GET /api/public-submissions/link (INNOBOX_SPEC.md §6.1, §24.9): the public form's address for
// the new-challenge page's copy link — set only while the form is live. The decision lives in
// ./handler (unit-tested); this file wires the session gate, the live state and the base URL.
import { publicBaseUrl } from "@innobox/shared/public-url";
import { requireUser } from "@/lib/auth";
import { loadPublicIntakeState } from "@/lib/public-intake-live";
import { withSystemLog } from "@/lib/system-log";
import { handleShareLink } from "./handler";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  return handleShareLink({
    gate: requireUser,
    live: async () => (await loadPublicIntakeState()).live,
    baseUrl: publicBaseUrl(),
  });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/public-submissions/link", handleGET);

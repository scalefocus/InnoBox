// POST /api/me/whats-new-seen (INNOBOX_SPEC.md §13.9): acknowledges a release for the What's new
// update notice. Called on the notice's dismissal (✕ or link — never on appearance) and by the
// /whats-new page on mount. `version` must be strict x.y.z and not greater than the server's
// APP_VERSION — a client cannot claim the future. The marker only ever advances (store.ts).
// Own-account display marker: not audited, and silent for presence (lib/presence.ts lists no
// /api/me path).
import { APP_VERSION } from "@innobox/shared/version";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { validStampVersion } from "@/lib/whats-new";
import { markWhatsNewSeen } from "../store";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const version = validStampVersion(read.value.version, APP_VERSION);
  if (!version) {
    return Response.json(
      { error: "version must be a release number like 1.2.3, no newer than the running release" },
      { status: 400 },
    );
  }

  const stamp = await markWhatsNewSeen(pool, gate.user.id, version);
  return Response.json(stamp);
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/me/whats-new-seen", handlePOST);

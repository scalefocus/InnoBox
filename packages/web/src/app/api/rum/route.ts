// POST /api/rum — the §14.12 real-user-monitoring beacon (INNOBOX_SPEC.md). Any signed-in user;
// the body is JSON sent as text/plain (so navigator.sendBeacon needs no preflight) and is parsed
// whatever its declared type.
//
// The session is read to authenticate and to key the rate limit, and for nothing else: the user id
// never reaches the store (§14.12 decision 2), the system log records this route without an actor,
// and the rate-limit warning omits the id. While collection is off every beacon is answered 204 and
// dropped unread. The route is not in the presence allowlist — a flush is not someone using InnoBox.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readBytesLimited } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { getRumSettings } from "@/lib/rum-settings";
import { withSystemLog } from "@/lib/system-log";
import { RUM_MAX_BEACON_BYTES, validateRumBeacon } from "@innobox/shared/rum";
import { insertRumBeacon } from "./store";

export const dynamic = "force-dynamic";

const accepted = () => new Response(null, { status: 204 });

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "rum", { anonymous: true });
  if (limited) return limited;

  // Switched off: discard without reading the body. A tab opened before the switch flipped keeps
  // sending until it reloads, and nothing it sends is kept.
  if (!(await getRumSettings(pool)).enabled) return accepted();

  const bytes = await readBytesLimited(req, RUM_MAX_BEACON_BYTES);
  if (!bytes.ok) return bytes.response;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes.value));
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const today = new Date().toISOString().slice(0, 10);
  const beacon = validateRumBeacon(parsed, today);
  if (!beacon.ok) return Response.json({ error: beacon.error }, { status: 400 });

  await insertRumBeacon(pool, beacon.value);
  return accepted();
}

// §14.7 wrapper: failures are recorded (with no actor), but never this route's 429s.
export const POST = withSystemLog("/api/rum", handlePOST, { anonymousActor: true, unrecordedStatuses: [429] });

// PUT /api/admin/ai/timeouts (INNOBOX_SPEC.md §22.8): per-task attempt timeouts,
// `{ calls: { <featureKey>: ms | null } }` — whole seconds, 10–900 s; only overrides are stored.
// Independent of the provider. Platform admin only; audited when it changes.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { setAiTimeouts } from "../store";
import { aiError } from "../responses";

export const dynamic = "force-dynamic";

async function handlePUT(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const result = await setAiTimeouts(pool, gate.user.id, read.value);
  if (!result.ok) return aiError(422, "invalid_timeout", result.error, { field: result.field });
  return Response.json({ timeouts: result.timeouts });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const PUT = withSystemLog("/api/admin/ai/timeouts", handlePUT);

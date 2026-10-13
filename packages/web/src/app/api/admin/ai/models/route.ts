// POST /api/admin/ai/models (INNOBOX_SPEC.md §22.4): the provider's model list for the card's
// dropdown — 20 s, no retry, no usage row. The stored key applies only to the stored provider and
// base URL. 200 with `ok: false` and the error when the provider refuses (the card falls back to
// free text); that failure is written to the system log with the provider diagnostic.
// Platform admin only.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { loadAiModels } from "../store";
import { parseAiConnectionInput } from "../validation";
import { aiAdminDeps, connectionRefusal, noteAiFailure } from "../responses";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const parsed = parseAiConnectionInput(read.value);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const outcome = await loadAiModels(pool, aiAdminDeps(), parsed.value);
  if (outcome.ok) return Response.json({ ok: true, models: outcome.models });
  if (outcome.status === "failed") return noteAiFailure(Response.json({ ok: false, error: outcome.error }), "model list", outcome.failure);
  return connectionRefusal(outcome);
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/admin/ai/models", handlePOST);

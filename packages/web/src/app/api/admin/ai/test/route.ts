// POST /api/admin/ai/test (INNOBOX_SPEC.md §22.5): tests the values currently in the form — a
// fixed connectivity prompt, 20 s, no retry. 200 with `ok: false` on a provider failure; 422 only
// for invalid input (a bad base URL, or a blank key the stored-token rule does not allow).
// Platform admin only. Tests are not audited; a failed one is written to the system log with the
// provider diagnostic (host, addresses, cause), which never reaches the response.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { testAiConfig } from "../store";
import { parseAiConfigInput } from "../validation";
import { aiAdminDeps, connectionRefusal, noteAiFailure } from "../responses";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const parsed = parseAiConfigInput(read.value);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const outcome = await testAiConfig(pool, aiAdminDeps(), gate.user.id, parsed.value);
  if (!outcome.ok) return connectionRefusal(outcome);
  return noteAiFailure(Response.json(outcome.result), "test", outcome.failure);
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/admin/ai/test", handlePOST);

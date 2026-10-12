// PUT /api/admin/ai/switches (INNOBOX_SPEC.md §22.4, §22.7): "Allow namespace-restricted content
// to be sent to the AI provider" and the per-task switches, all off by default. Independent of
// the provider. Platform admin only; each change audited as settings.<setting>_changed.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { setAiSwitches, switchableAiFeatures } from "../store";
import { parseAiSwitchesInput } from "../validation";

export const dynamic = "force-dynamic";

async function handlePUT(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const parsed = parseAiSwitchesInput(read.value, switchableAiFeatures());
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const { changed } = await setAiSwitches(pool, gate.user.id, parsed.value);
  return Response.json({ changed });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const PUT = withSystemLog("/api/admin/ai/switches", handlePUT);

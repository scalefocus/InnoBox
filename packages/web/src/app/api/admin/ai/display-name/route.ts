// PUT /api/admin/ai/display-name (INNOBOX_SPEC.md §22.8): the name end-user AI surfaces show —
// 1–24 printable characters, empty for the default "AI". Independent of the provider: usable
// without a configuration or AI_TOKEN_ENC_KEY. Platform admin only; audited when it changes.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { setAiDisplayName } from "../store";
import { aiError } from "../responses";

export const dynamic = "force-dynamic";

async function handlePUT(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const result = await setAiDisplayName(pool, gate.user.id, read.value.displayName);
  if (!result.ok) return aiError(422, "invalid_display_name", result.error);
  return Response.json({ displayName: result.displayName });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const PUT = withSystemLog("/api/admin/ai/display-name", handlePUT);

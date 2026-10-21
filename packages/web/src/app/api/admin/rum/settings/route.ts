// GET/PATCH /api/admin/rum/settings (INNOBOX_SPEC.md §14.12): the Collect telemetry switch and the
// sample rate, edited on the monitoring page itself. Platform admin only. A change writes one
// `settings.telemetry_changed` audit row with the resulting pair; a no-op patch writes nothing.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { getRumSettings, setRumSettings } from "@/lib/rum-settings";
import { withSystemLog } from "@/lib/system-log";
import { parseRumSettingsPatch } from "./validation";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  return Response.json(await getRumSettings(pool));
}

async function handlePATCH(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const patch = parseRumSettingsPatch(read.value);
  if (!patch.ok) return Response.json({ error: patch.error }, { status: patch.status });
  return Response.json(await setRumSettings(pool, patch.value, gate.user.id));
}

export const GET = withSystemLog("/api/admin/rum/settings", handleGET);
export const PATCH = withSystemLog("/api/admin/rum/settings", handlePATCH);

// GET/PATCH /api/admin/settings (INNOBOX_SPEC.md §14.3): attachment limits, impact areas,
// and the platform date-display format. Platform-admin only; every change audited.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getAttachmentLimits, getDateFormat, listAllImpactAreas, setAttachmentLimits, setDateFormat } from "./store";
import { parseSettingsPatch } from "./validation";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;

  const [dateFormat, attachmentLimits, impactAreas] = await Promise.all([
    getDateFormat(pool),
    getAttachmentLimits(pool),
    listAllImpactAreas(pool),
  ]);
  return Response.json({ dateFormat, attachmentLimits, impactAreas });
}

export async function PATCH(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  const parsed = parseSettingsPatch(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  if (parsed.value.dateFormat) await setDateFormat(pool, parsed.value.dateFormat, gate.user.id);
  if (parsed.value.attachmentLimits) await setAttachmentLimits(pool, parsed.value.attachmentLimits, gate.user.id);

  const [dateFormat, attachmentLimits] = await Promise.all([getDateFormat(pool), getAttachmentLimits(pool)]);
  return Response.json({ dateFormat, attachmentLimits });
}

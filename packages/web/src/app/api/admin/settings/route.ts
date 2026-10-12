// GET/PATCH /api/admin/settings (INNOBOX_SPEC.md §14.3): attachment limits, impact areas,
// the platform date-display format, and the feedback-survey switch (§14.11, `surveyEnabled`).
// Platform-admin only; every change audited.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getAttachmentLimits, getDateFormat, listAllImpactAreas, setAttachmentLimits, setDateFormat } from "./store";
import { parseSettingsPatch } from "./validation";
import { getFeaturedLimit, setFeaturedLimit } from "../../challenges/featured";
import { getSurveyEnabled, setSurveyEnabled } from "../../me/survey/store";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;

  const [dateFormat, attachmentLimits, impactAreas, featuredLimit, surveyEnabled] = await Promise.all([
    getDateFormat(pool),
    getAttachmentLimits(pool),
    listAllImpactAreas(pool),
    getFeaturedLimit(pool),
    getSurveyEnabled(pool),
  ]);
  return Response.json({ dateFormat, attachmentLimits, impactAreas, featuredLimit, surveyEnabled });
}

async function handlePATCH(req: Request): Promise<Response> {
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
  if (parsed.value.featuredLimit !== undefined) await setFeaturedLimit(pool, parsed.value.featuredLimit, gate.user.id);
  if (parsed.value.surveyEnabled !== undefined) await setSurveyEnabled(pool, parsed.value.surveyEnabled, gate.user.id);

  const [dateFormat, attachmentLimits, featuredLimit, surveyEnabled] = await Promise.all([
    getDateFormat(pool),
    getAttachmentLimits(pool),
    getFeaturedLimit(pool),
    getSurveyEnabled(pool),
  ]);
  return Response.json({ dateFormat, attachmentLimits, featuredLimit, surveyEnabled });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/settings", handleGET);
export const PATCH = withSystemLog("/api/admin/settings", handlePATCH);

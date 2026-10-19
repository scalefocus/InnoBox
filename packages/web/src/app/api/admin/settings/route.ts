// GET/PATCH /api/admin/settings (INNOBOX_SPEC.md §14.3): attachment limits, impact areas,
// the platform date-display format, the feedback-survey switch (§14.11, `surveyEnabled`), the bug-report
// switch (§13.10, `bugReportsEnabled`), and the
// public submissions card (§24.2, `publicSubmissions`), plus the §2.3 bootstrap-admin notice flag
// (`bootstrapAdminGroupActive`, GET only). Platform-admin only; every change audited.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import {
  countPlatformAdminMappings,
  getAttachmentLimits,
  getDateFormat,
  getGamificationEnabled,
  listAllImpactAreas,
  setAttachmentLimits,
  setDateFormat,
  setGamificationEnabled,
  setPublicSubmissionSettings,
} from "./store";
import { bootstrapAdminGroupActive } from "./bootstrap-admin";
import { publicSubmissionsCard } from "./public-submissions";
import { emailTransportAvailable, invalidatePublicIntakeState } from "@/lib/public-intake-live";
import { PRECONDITION_HINT, publicIntakeKey } from "@/lib/public-intake";
import { parseSettingsPatch } from "./validation";
import { getFeaturedLimit, setFeaturedLimit } from "../../challenges/featured";
import { getBugReportsEnabled, getSurveyEnabled, setBugReportsEnabled, setSurveyEnabled } from "../../me/survey/store";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;

  const [dateFormat, attachmentLimits, impactAreas, featuredLimit, surveyEnabled, bugReportsEnabled, gamificationEnabled, publicSubmissions, platformAdminMappings] =
    await Promise.all([
      getDateFormat(pool),
      getAttachmentLimits(pool),
      listAllImpactAreas(pool),
      getFeaturedLimit(pool),
      getSurveyEnabled(pool),
      getBugReportsEnabled(pool),
      getGamificationEnabled(pool),
      publicSubmissionsCard(),
      countPlatformAdminMappings(pool),
    ]);
  // §2.3: the standing bootstrap grant is flagged once a role mapping could replace it.
  const bootstrapActive = bootstrapAdminGroupActive(process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP, platformAdminMappings);
  return Response.json({
    dateFormat,
    attachmentLimits,
    impactAreas,
    featuredLimit,
    surveyEnabled,
    bugReportsEnabled,
    gamificationEnabled,
    publicSubmissions,
    bootstrapAdminGroupActive: bootstrapActive,
  });
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
  if (parsed.value.bugReportsEnabled !== undefined) await setBugReportsEnabled(pool, parsed.value.bugReportsEnabled, gate.user.id);
  if (parsed.value.gamificationEnabled !== undefined) await setGamificationEnabled(pool, parsed.value.gamificationEnabled, gate.user.id);
  if (parsed.value.publicSubmissions) {
    const result = await setPublicSubmissionSettings(pool, parsed.value.publicSubmissions, gate.user.id, {
      keyValid: publicIntakeKey() !== null,
      transportAvailable: await emailTransportAvailable(),
    });
    if (result.status === "precondition") {
      return Response.json({ error: PRECONDITION_HINT[result.missing], code: `public_submissions_${result.missing}` }, { status: 409 });
    }
    // §24.2: the public routes read a 10-second cache; a saved switch takes effect at once.
    invalidatePublicIntakeState();
  }

  const [dateFormat, attachmentLimits, featuredLimit, surveyEnabled, bugReportsEnabled, gamificationEnabled, publicSubmissions] = await Promise.all([
    getDateFormat(pool),
    getAttachmentLimits(pool),
    getFeaturedLimit(pool),
    getSurveyEnabled(pool),
    getBugReportsEnabled(pool),
    getGamificationEnabled(pool),
    publicSubmissionsCard(),
  ]);
  return Response.json({ dateFormat, attachmentLimits, featuredLimit, surveyEnabled, bugReportsEnabled, gamificationEnabled, publicSubmissions });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/settings", handleGET);
export const PATCH = withSystemLog("/api/admin/settings", handlePATCH);

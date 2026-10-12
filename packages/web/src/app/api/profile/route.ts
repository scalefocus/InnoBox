// GET/PATCH /api/profile (INNOBOX_SPEC.md §13.5): the signed-in user's own profile, the
// e-mail-notification opt-out toggle, and the feedback-survey opt-out (§13.10, `surveysEnabled`).
// Auth-required; no admin gate — every user manages their own profile.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { parsePreferencePatch, NOTIFICATION_PREFERENCES } from "@innobox/shared";
import { getOwnProfile, setEmailNotificationsEnabled, setNotificationPreferences } from "./store";
import { getSurveyEnabled, setSurveysEnabled } from "../me/survey/store";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const [profile, surveysOn] = await Promise.all([
    getOwnProfile(pool, { userId: gate.user.id, roles: gate.user.roles }),
    getSurveyEnabled(pool),
  ]);
  if (!profile) return Response.json({ error: "profile not found" }, { status: 404 });
  // `surveysPlatformEnabled` lets the Feedback section hide what the platform switch has turned off.
  return Response.json({ profile, surveysPlatformEnabled: surveysOn });
}

async function handlePATCH(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;

  // §13.10: the survey opt-out travels alone or beside the notification preferences.
  const { surveysEnabled, ...rest } = read.value;
  if (surveysEnabled !== undefined && typeof surveysEnabled !== "boolean") {
    return Response.json({ error: "surveysEnabled must be a boolean" }, { status: 400 });
  }
  if (surveysEnabled !== undefined && Object.keys(rest).length === 0) {
    await setSurveysEnabled(pool, gate.user.id, surveysEnabled);
    return Response.json({ surveysEnabled });
  }

  // §13.5 + §12.1: the e-mail switch and/or any of the three per-event toggles.
  const parsed = parsePreferencePatch(rest);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  if (surveysEnabled !== undefined) await setSurveysEnabled(pool, gate.user.id, surveysEnabled);

  if (parsed.value.emailNotificationsEnabled !== undefined) {
    await setEmailNotificationsEnabled(pool, gate.user.id, parsed.value.emailNotificationsEnabled);
  }
  if (NOTIFICATION_PREFERENCES.some((k) => parsed.value[k] !== undefined)) {
    await setNotificationPreferences(pool, gate.user.id, parsed.value);
  }
  return Response.json(surveysEnabled === undefined ? parsed.value : { ...parsed.value, surveysEnabled });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/profile", handleGET);
export const PATCH = withSystemLog("/api/profile", handlePATCH);

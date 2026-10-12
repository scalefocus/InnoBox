// GET/PATCH /api/profile (INNOBOX_SPEC.md §13.5): the signed-in user's own profile, the
// e-mail-notification opt-out toggle, the feedback-survey opt-out (§13.10, `surveysEnabled`), and
// the two gamification switches (§23.7/§23.9, `notifyAchievements` and `gamificationPublic`).
// Auth-required; no admin gate — every user manages their own profile.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { GAMIFICATION_PREFERENCE_KEYS, parseGamificationPreferences, parsePreferencePatch, NOTIFICATION_PREFERENCES } from "@innobox/shared";
import { getGamificationPreferences, getOwnProfile, setEmailNotificationsEnabled, setGamificationPreferences, setNotificationPreferences } from "./store";
import { getSurveyEnabled, setSurveysEnabled } from "../me/survey/store";
import { isGamificationOn, ownGamification } from "@/lib/gamification-read";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const [profile, surveysOn, gamificationOn] = await Promise.all([
    getOwnProfile(pool, { userId: gate.user.id, roles: gate.user.roles }),
    getSurveyEnabled(pool),
    isGamificationOn(pool),
  ]);
  if (!profile) return Response.json({ error: "profile not found" }, { status: 404 });
  // §23.6: the Achievements section and its two switches — both null while the feature is off.
  const [gamification, gamificationPreferences] = gamificationOn
    ? await Promise.all([ownGamification(pool, gate.user.id), getGamificationPreferences(pool, gate.user.id)])
    : [null, null];
  // `surveysPlatformEnabled` lets the Feedback section hide what the platform switch has turned off.
  return Response.json({ profile: { ...profile, gamification, gamificationPreferences }, surveysPlatformEnabled: surveysOn });
}

async function handlePATCH(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;

  // §13.10: the survey opt-out, and §23.7/§23.9 the two gamification switches, travel alone or
  // beside the notification preferences.
  const { surveysEnabled, ...rest } = read.value;
  if (surveysEnabled !== undefined && typeof surveysEnabled !== "boolean") {
    return Response.json({ error: "surveysEnabled must be a boolean" }, { status: 400 });
  }
  const gamified = parseGamificationPreferences(rest);
  if (!gamified.ok) return Response.json({ error: gamified.error }, { status: 400 });
  const notificationKeys = ["emailNotificationsEnabled", ...NOTIFICATION_PREFERENCES];
  const hasNotificationKeys = notificationKeys.some((k) => rest[k] !== undefined);
  const hasOther = surveysEnabled !== undefined || Object.keys(gamified.value).length > 0;

  // §13.5 + §12.1: the e-mail switch and/or any of the three per-event toggles.
  const parsed: ReturnType<typeof parsePreferencePatch> = !hasNotificationKeys && hasOther ? { ok: true, value: {} } : parsePreferencePatch(rest);
  if (!parsed.ok) {
    const error = parsed.error.startsWith("one of ") ? `${parsed.error}, surveysEnabled, ${GAMIFICATION_PREFERENCE_KEYS.join(", ")}` : parsed.error;
    return Response.json({ error }, { status: 400 });
  }

  if (surveysEnabled !== undefined) await setSurveysEnabled(pool, gate.user.id, surveysEnabled);
  if (parsed.value.emailNotificationsEnabled !== undefined) {
    await setEmailNotificationsEnabled(pool, gate.user.id, parsed.value.emailNotificationsEnabled);
  }
  if (NOTIFICATION_PREFERENCES.some((k) => parsed.value[k] !== undefined)) {
    await setNotificationPreferences(pool, gate.user.id, parsed.value);
  }
  // Silent (not audited, like the e-mail switch) and immediate.
  await setGamificationPreferences(pool, gate.user.id, gamified.value);
  return Response.json({ ...parsed.value, ...(surveysEnabled === undefined ? {} : { surveysEnabled }), ...gamified.value });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/profile", handleGET);
export const PATCH = withSystemLog("/api/profile", handlePATCH);

// The §16 `me` resource: session identity, DB-resolved role hints (UI only — enforcement
// stays server-side), the e-mail opt-out flag, and the platform date-display format
// (§14.3, `dateFormat` stays a TOP-LEVEL field — DateFormatProvider reads exactly that shape),
// the end-user name for AI features (§22.8, `aiDisplayName`, "AI" by default), the §13.9
// What's new marker + rollout boundary the AppShell update notice evaluates, and the open
// feedback-survey offer (§13.10, `openSurvey` — null whenever the platform switch is off), so the
// account menu's "Take the survey" needs no extra request — and `selfSurvey` (null while the
// switch is off, else `{ nextAt }`, null when an on-demand survey can start now) — and
// `bugReports` (true while both the survey and the bug-report switches are on).
import { getSessionUser, requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getDateFormat } from "@/app/api/admin/settings/store";
import { getAiDisplayNameSetting } from "@/app/api/admin/ai/store";
import { aiDisplayName } from "@innobox/shared/ai";
import { APP_VERSION } from "@innobox/shared/version";
import { markQuickStartSeen, markWhatsNewSeen } from "./store";
import { readBugReports, readOpenSurvey, readSelfSurvey } from "./survey/store";
import { meGamification, newAchievements } from "@/lib/gamification-read";
import { getMcpSettings, hasLiveConnection } from "@/lib/mcp/store";
import { getHypeEnabled } from "@/lib/hype-settings";
import { getRumSettings } from "@/lib/rum-settings";
import { viewerHypeBudget } from "../hypes/store";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

async function handleGET(): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const [dateFormat, aiName, openSurvey, selfSurvey, bugReports, gamification, achievements, mcp, connected, hypeOn, rum] = await Promise.all([
    getDateFormat(pool),
    getAiDisplayNameSetting(pool),
    readOpenSurvey(pool, user.id),
    readSelfSurvey(pool, user.id),
    readBugReports(pool),
    meGamification(pool, user.id),
    newAchievements(pool, user.id),
    getMcpSettings(pool),
    hasLiveConnection(pool, user.id),
    getHypeEnabled(pool),
    getRumSettings(pool),
  ]);
  // §26.11: the hype button's initial budget — null while hype is off.
  const hype = hypeOn ? { enabled: true, hypesLeft: (await viewerHypeBudget(pool, user.id)).hypesLeft } : null;

  const byRole = (role: "namespace_admin" | "committee"): string[] => [
    ...new Set(
      user.roles.grants
        .filter((g) => g.role === role && g.namespaceId !== null)
        .map((g) => g.namespaceId as string),
    ),
  ];

  return Response.json({
    dateFormat,
    user: {
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      userName: user.userName,
    },
    roles: {
      platformAdmin: user.roles.isPlatformAdmin,
      namespaceAdmin: byRole("namespace_admin"),
      committee: byRole("committee"),
      member: user.roles.memberNamespaces(),
    },
    emailNotificationsEnabled: user.emailNotificationsEnabled,
    quickStartSeenAt: user.quickStartSeenAt ? user.quickStartSeenAt.toISOString() : null,
    whatsNewSeenVersion: user.whatsNewSeenVersion,
    whatsNewSinceDate: user.whatsNewSinceDate,
    aiDisplayName: aiDisplayName(aiName),
    openSurvey,
    selfSurvey,
    // §13.10 *Bug reports*: the sidebar bug button and the picker's Bug option — both switches on.
    bugReports,
    // §23.12: the sidebar ring's level (null while the feature is off) and the §23.7 toast queue.
    gamification,
    newAchievements: achievements,
    // §25.9: the account menu's AI agents item — while agent access is on, or while the person
    // still holds a connection (so they can revoke it).
    agentsMenu: mcp.enabled || connected,
    hype,
    // §14.12: whether a new tab starts the monitoring collector, and at what sample rate.
    rum,
  });
}

async function handlePATCH(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  const quickStartSeen = body.quickStartSeen;
  if (quickStartSeen !== true) {
    return Response.json({ error: "quickStartSeen must be true" }, { status: 400 });
  }

  await markQuickStartSeen(pool, gate.user.id);
  // §13.9: finishing Quick start also acknowledges the running release (server-side, at the
  // SERVER's APP_VERSION), so a brand-new user never gets the notice for the version they
  // onboarded on.
  await markWhatsNewSeen(pool, gate.user.id, APP_VERSION);
  return Response.json({ quickStartSeen: true });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/me", handleGET);
export const PATCH = withSystemLog("/api/me", handlePATCH);

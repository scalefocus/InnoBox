// The §16 `me` resource: session identity, DB-resolved role hints (UI only — enforcement
// stays server-side), the e-mail opt-out flag, and the platform date-display format
// (§14.3, `dateFormat` stays a TOP-LEVEL field — DateFormatProvider reads exactly that shape),
// the end-user name for AI features (§22.8, `aiDisplayName`, "AI" by default), and the open
// feedback-survey offer (§13.10, `openSurvey` — null whenever the platform switch is off), so the
// account menu's "Take the survey" needs no extra request.
import { getSessionUser, requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getDateFormat } from "@/app/api/admin/settings/store";
import { getAiDisplayNameSetting } from "@/app/api/admin/ai/store";
import { aiDisplayName } from "@innobox/shared/ai";
import { markQuickStartSeen } from "./store";
import { readOpenSurvey } from "./survey/store";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

async function handleGET(): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const [dateFormat, aiName, openSurvey] = await Promise.all([
    getDateFormat(pool),
    getAiDisplayNameSetting(pool),
    readOpenSurvey(pool, user.id),
  ]);

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
    aiDisplayName: aiDisplayName(aiName),
    openSurvey,
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
  return Response.json({ quickStartSeen: true });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/me", handleGET);
export const PATCH = withSystemLog("/api/me", handlePATCH);

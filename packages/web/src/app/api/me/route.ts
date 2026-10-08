// The §16 `me` resource: session identity, DB-resolved role hints (UI only — enforcement
// stays server-side), the e-mail opt-out flag, and the platform date-display format
// (§14.3, `dateFormat` stays a TOP-LEVEL field — DateFormatProvider reads exactly that shape).
import { getSessionUser, requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getDateFormat } from "@/app/api/admin/settings/store";
import { markQuickStartSeen } from "./store";

export async function GET(): Promise<Response> {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const dateFormat = await getDateFormat(pool);

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
  });
}

export async function PATCH(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const quickStartSeen = (body as Record<string, unknown>).quickStartSeen;
  if (quickStartSeen !== true) {
    return Response.json({ error: "quickStartSeen must be true" }, { status: 400 });
  }

  await markQuickStartSeen(pool, gate.user.id);
  return Response.json({ quickStartSeen: true });
}

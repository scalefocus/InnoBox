// GET/PATCH /api/profile (INNOBOX_SPEC.md §13.5): the signed-in user's own profile, and
// the e-mail-notification opt-out toggle. Auth-required; no admin gate — every user manages
// their own profile.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { parsePreferencePatch, NOTIFICATION_PREFERENCES } from "@innobox/shared";
import { getOwnProfile, setEmailNotificationsEnabled, setNotificationPreferences } from "./store";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const profile = await getOwnProfile(pool, gate.user.id);
  if (!profile) return Response.json({ error: "profile not found" }, { status: 404 });
  return Response.json({ profile });
}

async function handlePATCH(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  // §13.5 + §12.1: the e-mail switch and/or any of the three per-event toggles.
  const parsed = parsePreferencePatch(read.value);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  if (parsed.value.emailNotificationsEnabled !== undefined) {
    await setEmailNotificationsEnabled(pool, gate.user.id, parsed.value.emailNotificationsEnabled);
  }
  if (NOTIFICATION_PREFERENCES.some((k) => parsed.value[k] !== undefined)) {
    await setNotificationPreferences(pool, gate.user.id, parsed.value);
  }
  return Response.json(parsed.value);
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/profile", handleGET);
export const PATCH = withSystemLog("/api/profile", handlePATCH);

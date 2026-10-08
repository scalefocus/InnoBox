// GET/PATCH /api/profile (INNOBOX_SPEC.md §13.5): the signed-in user's own profile, and
// the e-mail-notification opt-out toggle. Auth-required; no admin gate — every user manages
// their own profile.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getOwnProfile, setEmailNotificationsEnabled } from "./store";
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
  const body = read.value;
  const enabled = body.emailNotificationsEnabled;
  if (typeof enabled !== "boolean") {
    return Response.json({ error: "emailNotificationsEnabled must be a boolean" }, { status: 400 });
  }

  await setEmailNotificationsEnabled(pool, gate.user.id, enabled);
  return Response.json({ emailNotificationsEnabled: enabled });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/profile", handleGET);
export const PATCH = withSystemLog("/api/profile", handlePATCH);

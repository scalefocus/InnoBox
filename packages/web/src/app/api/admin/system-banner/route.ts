// GET/PUT/DELETE /api/admin/system-banner (INNOBOX_SPEC.md §14.6): the platform-admin side of
// the header announcement. PUT is an unconditional upsert (the countdown restarts from the
// save); DELETE clears it immediately. Both audited. GET returns the stored banner plus whether
// it is still active, for the Administration card.
import { isSystemBannerActive, validateSystemBannerInput } from "@innobox/shared";
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { clearSystemBanner, getStoredSystemBanner, setSystemBanner } from "./store";
import { rateLimit } from "@/lib/rate-limit";
import { readJsonObject } from "@/lib/http";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const banner = await getStoredSystemBanner(pool);
  return Response.json({ banner, active: isSystemBannerActive(banner) });
}

async function handlePUT(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  const parsed = validateSystemBannerInput(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const banner = await setSystemBanner(pool, parsed.value, gate.user.id);
  return Response.json({ banner, active: true });
}

async function handleDELETE(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  await clearSystemBanner(pool, gate.user.id);
  return Response.json({ banner: null, active: false });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/system-banner", handleGET);
export const PUT = withSystemLog("/api/admin/system-banner", handlePUT);
export const DELETE = withSystemLog("/api/admin/system-banner", handleDELETE);

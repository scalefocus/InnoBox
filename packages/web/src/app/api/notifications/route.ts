// GET/PATCH /api/notifications (INNOBOX_SPEC.md §12.2): the in-app inbox. Newest-first,
// with unread count. PATCH marks all read (single-notification mark-read is
// /api/notifications/:id).
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getInbox, markAllRead } from "./store";
import { rateLimit } from "@/lib/rate-limit";
import { getActiveSystemBanner } from "../admin/system-banner/store";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  // §14.6: the active system banner rides the bell's 30-second poll — one round trip, no second
  // transport. Null when none is active (lazy expiry judged here, at read time).
  const [inbox, banner] = await Promise.all([getInbox(pool, gate.user.id), getActiveSystemBanner(pool)]);
  return Response.json({ ...inbox, banner });
}

async function handlePATCH(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  await markAllRead(pool, gate.user.id);
  return Response.json({ ok: true });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/notifications", handleGET);
export const PATCH = withSystemLog("/api/notifications", handlePATCH);

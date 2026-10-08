// GET/PATCH /api/notifications (INNOBOX_SPEC.md §12.2): the in-app inbox. Newest-first,
// with unread count. PATCH marks all read (single-notification mark-read is
// /api/notifications/:id).
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getInbox, markAllRead } from "./store";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const inbox = await getInbox(pool, gate.user.id);
  return Response.json(inbox);
}

export async function PATCH(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  await markAllRead(pool, gate.user.id);
  return Response.json({ ok: true });
}

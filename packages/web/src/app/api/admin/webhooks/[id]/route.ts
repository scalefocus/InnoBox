// PATCH/DELETE /api/admin/webhooks/:id (INNOBOX_SPEC.md §12.4, §16): edit (name, format, enabled
// and — only when non-empty — the URL) or delete a channel webhook. Platform admin only. An
// unknown id is 404 before any other refusal; with WEBHOOK_ENC_KEY unset an edit is 409, while
// a delete still works (it needs no key).
import { parseWebhookPatch } from "@innobox/shared";
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { isUuid } from "../../validation";
import { deleteWebhook, updateWebhook } from "../store";
import { webhookDeps, webhookWriteResponse } from "../responses";

export const dynamic = "force-dynamic";

const NOT_FOUND = "webhook not found";

async function handlePATCH(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: NOT_FOUND }, { status: 404 });
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const parsed = parseWebhookPatch(read.value);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const result = await updateWebhook(pool, webhookDeps(), gate.user.id, id, parsed.value);
  return webhookWriteResponse(result, NOT_FOUND);
}

async function handleDELETE(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: NOT_FOUND }, { status: 404 });
  const result = await deleteWebhook(pool, gate.user.id, id);
  if (result.status === "not_found") return Response.json({ error: NOT_FOUND }, { status: 404 });
  return Response.json({ ok: true });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const PATCH = withSystemLog("/api/admin/webhooks/[id]", handlePATCH);
export const DELETE = withSystemLog("/api/admin/webhooks/[id]", handleDELETE);

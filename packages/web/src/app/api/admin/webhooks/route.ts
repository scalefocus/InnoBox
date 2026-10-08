// GET/POST /api/admin/webhooks (INNOBOX_SPEC.md §12.4, §16): the platform-admin listing of every
// namespace with its channel webhooks, and creating one. Platform admin only (403 otherwise).
// The URL is write-only: responses carry `urlHint`, never the URL.
import { parseWebhookCreate } from "@innobox/shared";
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { webhookKey } from "@/lib/webhooks";
import { createWebhook, listWebhooks } from "./store";
import { webhookDeps, webhookWriteResponse } from "./responses";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const namespaces = await listWebhooks(pool);
  return Response.json({ configured: webhookKey() !== null, namespaces });
}

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const parsed = parseWebhookCreate(read.value);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const result = await createWebhook(pool, webhookDeps(), gate.user.id, parsed.value);
  return webhookWriteResponse(result, "namespace not found", 201);
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/webhooks", handleGET);
export const POST = withSystemLog("/api/admin/webhooks", handlePOST);

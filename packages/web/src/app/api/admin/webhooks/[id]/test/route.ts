// POST /api/admin/webhooks/:id/test (INNOBOX_SPEC.md §12.4, §16): the synchronous Send test — a
// fixed synthetic payload through the same SSRF guard, 10 s timeout and no-redirect rules, one
// attempt. Answers 200 `{ ok, httpStatus?, reason?, durationMs }` whatever the receiver did, so a
// failed test is shown inline and never lands in the system log (it is audited instead). Works on
// a disabled webhook. Platform admin only.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { isUuid } from "../../../validation";
import { testWebhook } from "../../store";
import { notConfiguredResponse, webhookDeps } from "../../responses";

export const dynamic = "force-dynamic";

async function handlePOST(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: "webhook not found" }, { status: 404 });
  const result = await testWebhook(pool, webhookDeps(), gate.user.id, id);
  if (result.status === "not_found") return Response.json({ error: "webhook not found" }, { status: 404 });
  if (result.status === "not_configured") return notConfiguredResponse();
  return Response.json(result.result);
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/admin/webhooks/[id]/test", handlePOST);

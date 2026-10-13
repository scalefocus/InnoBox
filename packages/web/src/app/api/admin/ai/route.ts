// GET/PUT/PATCH/DELETE /api/admin/ai (INNOBOX_SPEC.md §22.4, §22.5, §22.9): the AI provider card's
// state, saving a configuration (test first — a failing save persists nothing), switching AI on
// or off, and removing the integration. Platform admin only (403 otherwise). The API key is
// write-only: no response carries it or its ciphertext. Every write answers 409 ai_key_missing
// without AI_TOKEN_ENC_KEY.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { getAiAdminView, removeAiConfig, saveAiConfig, setAiEnabled } from "./store";
import { parseAiConfigInput, parseAiEnabledPatch } from "./validation";
import { AI_ENABLE_REFUSALS, aiAdminDeps, aiError, connectionRefusal, keyMissingResponse, noteAiSaveFailure } from "./responses";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  return Response.json(await getAiAdminView(pool, aiAdminDeps()));
}

async function handlePUT(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const parsed = parseAiConfigInput(read.value);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const deps = aiAdminDeps();
  const outcome = await saveAiConfig(pool, deps, gate.user.id, parsed.value);
  if (!outcome.ok) {
    if (outcome.status === "test_failed") {
      return noteAiSaveFailure(aiError(422, "ai_test_failed", "The test failed, so nothing was saved", { result: outcome.result }), outcome.failure);
    }
    return connectionRefusal(outcome);
  }
  return Response.json({ saved: outcome.status === "saved", ai: await getAiAdminView(pool, deps) });
}

async function handlePATCH(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const parsed = parseAiEnabledPatch(read.value);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const deps = aiAdminDeps();
  const outcome = await setAiEnabled(pool, deps, gate.user.id, parsed.value.enabled);
  if (!outcome.ok) {
    if (outcome.status === "key_missing") return keyMissingResponse();
    const refusal = AI_ENABLE_REFUSALS[outcome.status];
    return aiError(409, refusal.code, refusal.message);
  }
  return Response.json({ ai: await getAiAdminView(pool, deps) });
}

async function handleDELETE(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const outcome = await removeAiConfig(pool, aiAdminDeps(), gate.user.id);
  if (!outcome.ok) return keyMissingResponse();
  return new Response(null, { status: 204 });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
// The wrapper records only the `{ error }` message — never a request body, so the key in a PUT
// never reaches the log.
export const GET = withSystemLog("/api/admin/ai", handleGET);
export const PUT = withSystemLog("/api/admin/ai", handlePUT);
export const PATCH = withSystemLog("/api/admin/ai", handlePATCH);
export const DELETE = withSystemLog("/api/admin/ai", handleDELETE);

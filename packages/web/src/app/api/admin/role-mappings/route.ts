// GET/POST /api/admin/role-mappings — platform-admin only (ENTRA_AUTH_SPEC.md §5 layer 3).
// GET joins the SCIM-synced groups mirror for display names (no match → dead: true) and the
// namespace slug. POST enforces the platform_admin ⇔ null-namespace pairing as a 400 before
// the DB CHECK can fire; creation is audited (role_mapping.created) in the store.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { parseRoleMappingCreate } from "../validation";
import { createRoleMapping, listRoleMappings } from "../store";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

// Admin lists must never be prerendered or cached — always hit the DB per request.
export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  return Response.json({ mappings: await listRoleMappings(pool) });
}

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  const parsed = parseRoleMappingCreate(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const result = await createRoleMapping(pool, parsed.value, gate.user.id);
  if (result.status === "unknown_namespace") {
    return Response.json({ error: "namespaceId does not reference an existing namespace" }, { status: 400 });
  }
  if (result.status === "duplicate") {
    return Response.json({ error: "this group → role mapping already exists" }, { status: 409 });
  }
  return Response.json({ mapping: result.mapping }, { status: 201 });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/role-mappings", handleGET);
export const POST = withSystemLog("/api/admin/role-mappings", handlePOST);

// GET/POST /api/admin/namespaces — platform-admin only (ENTRA_AUTH_SPEC.md §5 layer 3).
// Validation 400s and slug-conflict 409s carry a JSON { error }; creation is audited
// (namespace.created) atomically with the insert in the store.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { parseNamespaceCreate } from "../validation";
import { createNamespace, listNamespaces } from "../store";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

// Admin lists must never be prerendered or cached — always hit the DB per request.
export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  return Response.json({ namespaces: await listNamespaces(pool) });
}

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  const parsed = parseNamespaceCreate(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const namespace = await createNamespace(pool, parsed.value, gate.user.id);
  if (!namespace) {
    return Response.json(
      { error: `a namespace with slug "${parsed.value.slug}" already exists` },
      { status: 409 },
    );
  }
  return Response.json({ namespace }, { status: 201 });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/namespaces", handleGET);
export const POST = withSystemLog("/api/admin/namespaces", handlePOST);

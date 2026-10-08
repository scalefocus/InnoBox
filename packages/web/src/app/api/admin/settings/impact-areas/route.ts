// POST /api/admin/settings/impact-areas (INNOBOX_SPEC.md §5, §14.3): add an impact area.
// Platform-admin only; audited.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { createImpactArea } from "../store";
import { parseImpactAreaCreate } from "../validation";

export async function POST(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const parsed = parseImpactAreaCreate(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const result = await createImpactArea(pool, parsed.value.name, gate.user.id);
  if (result.status === "duplicate") return Response.json({ error: "an impact area with that name already exists" }, { status: 409 });
  return Response.json({ area: result.area }, { status: 201 });
}

// POST /api/admin/email/wrapper (INNOBOX_SPEC.md §12.1): author the branded HTML wrapper
// template wrapping every outgoing notification e-mail. Platform-admin only; sanitized,
// validated (exactly one [SYSTEM MESSAGE] placeholder), and audited.
import { requirePlatformAdmin } from "@/lib/auth";
import { saveEmailWrapper } from "@/lib/email";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  const html = body.html;
  if (typeof html !== "string") return Response.json({ error: "html must be a string" }, { status: 400 });

  const result = await saveEmailWrapper(html, gate.user.id);
  if ("error" in result) return Response.json({ error: result.error }, { status: 400 });
  return Response.json({ html: result.sanitized });
}

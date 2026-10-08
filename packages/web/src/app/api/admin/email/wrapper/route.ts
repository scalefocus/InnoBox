// POST /api/admin/email/wrapper (INNOBOX_SPEC.md §12.1): author the branded HTML wrapper
// template wrapping every outgoing notification e-mail. Platform-admin only; sanitized,
// validated (exactly one [SYSTEM MESSAGE] placeholder), and audited.
import { requirePlatformAdmin } from "@/lib/auth";
import { saveEmailWrapper } from "@/lib/email";

export async function POST(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const html = (body as Record<string, unknown>).html;
  if (typeof html !== "string") return Response.json({ error: "html must be a string" }, { status: 400 });

  const result = await saveEmailWrapper(html, gate.user.id);
  if ("error" in result) return Response.json({ error: result.error }, { status: 400 });
  return Response.json({ html: result.sanitized });
}

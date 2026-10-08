// POST /api/attachments/uploads/:uploadId/abort — discard a chunked upload the client is
// abandoning (INNOBOX_SPEC.md §11). Aborts the MinIO multipart (frees the parts), drops the
// session row, and audits `attachment.upload_aborted`. No object is ever exposed.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";
import { abortChunkedUpload } from "../../../store";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, context: { params: Promise<{ uploadId: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { uploadId } = await context.params;

  const viewer = { userId: gate.user.id, roles: gate.user.roles };
  const result = await abortChunkedUpload({ pool, storage: getStorage() }, viewer, uploadId);
  if (result.status === "not_found") return Response.json({ error: "upload session not found" }, { status: 404 });
  return Response.json({ ok: true });
}

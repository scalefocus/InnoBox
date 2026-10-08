// PUT /api/attachments/uploads/:uploadId/parts/:n — stream one chunk of a chunked upload
// (INNOBOX_SPEC.md §11). The raw request body IS the chunk; the server relays it to the open
// MinIO multipart upload as part `n` (1-based). Only the session's uploader may send parts.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getStorage } from "@/lib/storage";
import { uploadChunkPart } from "../../../../store";

export const dynamic = "force-dynamic";

export async function PUT(req: Request, context: { params: Promise<{ uploadId: string; n: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { uploadId, n } = await context.params;
  const partNumber = Number(n);

  const bytes = new Uint8Array(await req.arrayBuffer());
  const viewer = { userId: gate.user.id, roles: gate.user.roles };
  const result = await uploadChunkPart({ pool, storage: getStorage() }, viewer, uploadId, partNumber, bytes);
  switch (result.status) {
    case "ok":
      return Response.json({ ok: true });
    case "not_found":
      return Response.json({ error: "upload session not found" }, { status: 404 });
    case "bad_request":
      return Response.json({ error: result.error }, { status: 400 });
  }
}

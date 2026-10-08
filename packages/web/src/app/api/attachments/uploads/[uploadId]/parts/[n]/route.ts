// PUT /api/attachments/uploads/:uploadId/parts/:n — stream one chunk of a chunked upload
// (INNOBOX_SPEC.md §11). The raw request body IS the chunk; the server relays it to the open
// MinIO multipart upload as part `n` (1-based). Only the session's uploader may send parts.
// The body is capped at the session's negotiated chunk size (§2.4) — the session is looked up
// first, and an over-long Content-Length is refused before a byte is read. The store then
// enforces the declared-size binding (part number in range, exact part size) and runs the
// content check on part 1.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { declaredLengthExceeds, readBytesLimited } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";
import { getOwnUploadChunkSize, uploadChunkPart } from "../../../../store";

export const dynamic = "force-dynamic";

export async function PUT(req: Request, context: { params: Promise<{ uploadId: string; n: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { uploadId, n } = await context.params;
  const partNumber = /^\d+$/.test(n) ? Number(n) : NaN;
  if (!Number.isInteger(partNumber) || partNumber < 1) {
    return Response.json({ error: "partNumber must be a positive integer" }, { status: 400 });
  }

  const viewer = { userId: gate.user.id, roles: gate.user.roles };
  const chunkSizeBytes = await getOwnUploadChunkSize(pool, viewer, uploadId);
  if (chunkSizeBytes === null) return Response.json({ error: "upload session not found" }, { status: 404 });
  if (declaredLengthExceeds(req, chunkSizeBytes)) {
    return Response.json({ error: "request body is too large" }, { status: 413 });
  }
  const body = await readBytesLimited(req, chunkSizeBytes);
  if (!body.ok) return body.response;

  const result = await uploadChunkPart({ pool, storage: getStorage() }, viewer, uploadId, partNumber, body.value);
  switch (result.status) {
    case "ok":
      return Response.json({ ok: true });
    case "not_found":
      return Response.json({ error: "upload session not found" }, { status: 404 });
    case "bad_request":
      return Response.json({ error: result.error }, { status: 400 });
    case "content_mismatch":
      return Response.json({ error: "The file's contents don't match its type." }, { status: 415 });
  }
}

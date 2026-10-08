// POST /api/attachments/uploads — initiate a chunked upload (INNOBOX_SPEC.md §11). For files
// larger than the configured chunk size only; files ≤ chunk size use single-shot POST
// /api/attachments. Validates the §14.3 cap, size, and allowlist UP FRONT (fail-fast), opens a
// server-proxied MinIO multipart upload, and returns { uploadId, chunkSizeBytes }. Chunks are
// then PUT to /uploads/:uploadId/parts/:n and assembled by POST /uploads/:uploadId/complete —
// no presigned/direct-store URLs are ever emitted (invariant 4). Rate-limited per user as an
// upload start; the JSON body goes through the §2.4 reader (415/413/400, never a 500).
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";
import { isUuid } from "../../challenges/validation";
import { initiateChunkedUpload } from "../store";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "upload");
  if (limited) return limited;

  const body = await readJsonObject(req);
  if (!body.ok) return body.response;
  const rec = body.value;
  const parentType = rec.parentType;
  const filename = rec.filename;
  const mime = rec.mime;
  const size = rec.size;
  if (parentType !== "challenge" && parentType !== "solution") {
    return Response.json({ error: "parentType must be 'challenge' or 'solution'" }, { status: 400 });
  }
  if (typeof filename !== "string" || filename.trim() === "") return Response.json({ error: "filename is required" }, { status: 400 });
  if (typeof mime !== "string" || mime.trim() === "") return Response.json({ error: "mime is required" }, { status: 400 });
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) return Response.json({ error: "size must be a non-negative integer" }, { status: 400 });

  const staged = typeof rec.draftKey === "string" && rec.draftKey !== "";
  if (staged) {
    if (!isUuid(rec.draftKey as string)) return Response.json({ error: "draftKey must be a uuid" }, { status: 400 });
  } else if (typeof rec.parentId !== "string" || rec.parentId === "") {
    return Response.json({ error: "parentId or draftKey is required" }, { status: 400 });
  }

  const viewer = { userId: gate.user.id, roles: gate.user.roles };
  const result = await initiateChunkedUpload({ pool, storage: getStorage() }, viewer, {
    parentType,
    parentId: staged ? undefined : (rec.parentId as string),
    draftKey: staged ? (rec.draftKey as string) : undefined,
    filename,
    mime,
    size,
  });

  switch (result.status) {
    case "ok":
      return Response.json({ uploadId: result.uploadId, chunkSizeBytes: result.chunkSizeBytes }, { status: 201 });
    case "not_found":
      return Response.json({ error: "that challenge or solution was not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: "only the author can attach files to this item" }, { status: 403 });
    case "not_editable":
      return Response.json({ error: "attachments can only be added while the item is editable" }, { status: 409 });
    case "too_many":
      return Response.json({ error: "attachment limit reached for this item" }, { status: 409 });
    case "too_large":
      return Response.json({ error: "file exceeds the maximum upload size" }, { status: 413 });
    case "unsupported_type":
      return Response.json({ error: "that file type is not allowed" }, { status: 415 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/attachments/uploads", handlePOST);

// POST /api/attachments/uploads/:uploadId/complete — assemble the uploaded chunks into the
// single immutable object and materialize the `pending` attachments row (INNOBOX_SPEC.md §11).
// First verifies the assembly against the declared size (a missing or wrongly-sized part aborts
// the upload: 400 with code `upload_incomplete`, and the client must start over); then re-checks
// the edit-window + per-item cap before committing; fires the on-demand scan after.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";
import { completeChunkedUpload } from "../../../store";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handlePOST(_req: Request, context: { params: Promise<{ uploadId: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { uploadId } = await context.params;

  const viewer = { userId: gate.user.id, roles: gate.user.roles };
  const result = await completeChunkedUpload({ pool, storage: getStorage() }, viewer, uploadId);
  switch (result.status) {
    case "ok":
      return Response.json({ attachment: result.attachment }, { status: 201 });
    case "not_found":
      return Response.json({ error: "upload session not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: "only the author can attach files to this item" }, { status: 403 });
    case "not_editable":
      return Response.json({ error: "attachments can only be added while the item is editable" }, { status: 409 });
    case "too_many":
      return Response.json({ error: "attachment limit reached for this item" }, { status: 409 });
    case "upload_incomplete":
      return Response.json(
        { error: "the upload was incomplete — please upload the file again", code: "upload_incomplete" },
        { status: 400 },
      );
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/attachments/uploads/[uploadId]/complete", handlePOST);

// POST /api/attachments/uploads/:uploadId/complete — assemble the uploaded chunks into the
// single immutable object and materialize the `pending` attachments row (INNOBOX_SPEC.md §11).
// Re-checks the edit-window + per-item cap before committing; fires the on-demand scan after.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getStorage } from "@/lib/storage";
import { completeChunkedUpload } from "../../../store";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, context: { params: Promise<{ uploadId: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
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
  }
}

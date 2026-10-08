// GET/POST /api/attachments (INNOBOX_SPEC.md §11).
//   POST — multipart upload of a challenge/solution attachment. Two shapes:
//          • bound   (parentId): the store enforces author-only + edit-window (§10.1);
//          • staged  (draftKey): the submission forms attach files before the parent exists
//            (§6.1/§6.2) — any authenticated user may stage under their own draftKey.
//          Both enforce the §14.3 limits (over-count 409, over-size 413) and the allowlist (415).
//          A hard size cap is applied here before the whole file is buffered into memory.
//   GET  — ?draftKey=<uuid>: list the caller's OWN staged attachments (status only, no bytes).
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getStorage } from "@/lib/storage";
import { getAttachmentLimits } from "../admin/settings/store";
import { isUuid } from "../challenges/validation";
import { listStagedAttachments, stageAttachment, uploadAttachment } from "./store";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const draftKey = new URL(req.url).searchParams.get("draftKey");
  if (typeof draftKey !== "string" || !isUuid(draftKey)) {
    return Response.json({ error: "draftKey (uuid) is required" }, { status: 400 });
  }
  const attachments = await listStagedAttachments(pool, { userId: gate.user.id, roles: gate.user.roles }, draftKey);
  return Response.json({ attachments });
}

export async function POST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "expected multipart/form-data with a file" }, { status: 400 });
  }

  const parentType = form.get("parentType");
  const parentId = form.get("parentId");
  const draftKey = form.get("draftKey");
  const file = form.get("file");
  if (parentType !== "challenge" && parentType !== "solution") {
    return Response.json({ error: "parentType must be 'challenge' or 'solution'" }, { status: 400 });
  }
  if (!(file instanceof File)) {
    return Response.json({ error: "a file is required" }, { status: 400 });
  }
  // Exactly one target: a staged draftKey (before the parent exists) or a bound parentId.
  const staged = typeof draftKey === "string" && draftKey !== "";
  if (staged) {
    if (!isUuid(draftKey as string)) return Response.json({ error: "draftKey must be a uuid" }, { status: 400 });
  } else if (typeof parentId !== "string" || parentId === "") {
    return Response.json({ error: "parentId or draftKey is required" }, { status: 400 });
  }

  // Hard size cap up front (using the declared size) so an oversized upload is rejected before
  // it is buffered fully into memory. The store re-checks the actual byte length authoritatively.
  const limits = await getAttachmentLimits(pool);
  const maxBytes = limits.maxUploadSizeMb * 1024 * 1024;
  if (file.size > maxBytes) {
    return Response.json({ error: `file exceeds the ${limits.maxUploadSizeMb} MB limit` }, { status: 413 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const viewer = { userId: gate.user.id, roles: gate.user.roles };
  const common = {
    parentType: parentType as "challenge" | "solution",
    filename: file.name,
    mime: file.type || "application/octet-stream",
    size: bytes.byteLength,
    bytes,
  };

  if (staged) {
    const result = await stageAttachment({ pool, storage: getStorage() }, viewer, { ...common, draftKey: draftKey as string });
    switch (result.status) {
      case "ok":
        return Response.json({ attachment: result.attachment }, { status: 201 });
      case "too_many":
        return Response.json({ error: `at most ${limits.maxPerItem} attachments are allowed per item` }, { status: 409 });
      case "too_large":
        return Response.json({ error: `file exceeds the ${limits.maxUploadSizeMb} MB limit` }, { status: 413 });
      case "unsupported_type":
        return Response.json({ error: "that file type is not allowed" }, { status: 415 });
    }
  }

  const result = await uploadAttachment({ pool, storage: getStorage() }, viewer, { ...common, parentId: parentId as string });
  switch (result.status) {
    case "ok":
      return Response.json({ attachment: result.attachment }, { status: 201 });
    case "not_found":
      return Response.json({ error: "that challenge or solution was not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: "only the author can attach files to this item" }, { status: 403 });
    case "not_editable":
      return Response.json({ error: "attachments can only be added while the item is editable" }, { status: 409 });
    case "too_many":
      return Response.json({ error: `at most ${limits.maxPerItem} attachments are allowed per item` }, { status: 409 });
    case "too_large":
      return Response.json({ error: `file exceeds the ${limits.maxUploadSizeMb} MB limit` }, { status: 413 });
    case "unsupported_type":
      return Response.json({ error: "that file type is not allowed" }, { status: 415 });
  }
}

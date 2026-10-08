// GET/POST /api/attachments (INNOBOX_SPEC.md §11).
//   POST — multipart upload of a challenge/solution attachment. Two shapes:
//          • bound   (parentId): the store enforces author-only + edit-window (§10.1);
//          • staged  (draftKey): the submission forms attach files before the parent exists
//            (§6.1/§6.2) — any authenticated user may stage under their own draftKey.
//          Both enforce the §14.3 limits (over-count 409, over-size 413), the allowlist (415), and
//          the content check (415). Single-shot is for files up to the chunk size, so the request
//          body is capped at the chunk size plus multipart overhead (§2.4) — refused from
//          Content-Length before anything is read, else by a running byte count — and only then
//          parsed as form data. Rate-limited per user as an upload start (§2.4).
//   GET  — ?draftKey=<uuid>: list the caller's OWN staged attachments (status only, no bytes).
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { declaredLengthExceeds, MULTIPART_OVERHEAD_BYTES, readBytesLimited } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { getStorage } from "@/lib/storage";
import { getAttachmentLimits } from "../admin/settings/store";
import { isUuid } from "../challenges/validation";
import { listStagedAttachments, stageAttachment, uploadAttachment } from "./store";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const draftKey = new URL(req.url).searchParams.get("draftKey");
  if (typeof draftKey !== "string" || !isUuid(draftKey)) {
    return Response.json({ error: "draftKey (uuid) is required" }, { status: 400 });
  }
  const attachments = await listStagedAttachments(pool, { userId: gate.user.id, roles: gate.user.roles }, draftKey);
  return Response.json({ attachments });
}

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "upload");
  if (limited) return limited;

  // §2.4 body limit, enforced BEFORE the body is buffered: anything larger than one chunk (plus
  // multipart framing) must use the chunked protocol. Content-Length is checked first; a body
  // without one is cut off by the running count in readBytesLimited.
  const limits = await getAttachmentLimits(pool);
  const maxBodyBytes = limits.chunkSizeMb * 1024 * 1024 + MULTIPART_OVERHEAD_BYTES;
  if (declaredLengthExceeds(req, maxBodyBytes)) {
    return Response.json({ error: "request body is too large" }, { status: 413 });
  }
  const raw = await readBytesLimited(req, maxBodyBytes);
  if (!raw.ok) return raw.response;

  let form: FormData;
  try {
    const contentType = req.headers.get("content-type") ?? "";
    form = await new Response(new Blob([new Uint8Array(raw.value)]), { headers: { "content-type": contentType } }).formData();
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

  // The §14.3 max-upload size (the body cap above already bounds what was read). The store
  // re-checks the actual byte length authoritatively.
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
      case "content_mismatch":
        return Response.json({ error: "The file's contents don't match its type." }, { status: 415 });
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
    case "content_mismatch":
      return Response.json({ error: "The file's contents don't match its type." }, { status: 415 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/attachments", handleGET);
export const POST = withSystemLog("/api/attachments", handlePOST);

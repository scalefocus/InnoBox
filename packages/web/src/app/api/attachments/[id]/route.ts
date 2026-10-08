// GET/DELETE /api/attachments/:id (INNOBOX_SPEC.md §11).
//   GET    — the authenticated download gateway (invariant 4): streams bytes only when the row
//            is clean, not removed, and the viewer can see the parent; any denial is an identical
//            404 (no not-found / not-visible / not-clean oracle) and is audited. No presigned/
//            direct MinIO URLs are ever emitted. The bytes are streamed (never buffered whole)
//            under `nosniff` + a sandboxing CSP.
//   DELETE — author removal: uploader-only, only within the parent's §10.1 edit window.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { ATTACHMENT_DOWNLOAD_CSP } from "@/lib/security-headers";
import { getStorage } from "@/lib/storage";
import { getAttachmentForDownload, removeAttachment } from "../store";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

/** Build a header-safe Content-Disposition value: an ASCII-folded quoted filename plus the
 *  RFC 5987 UTF-8 form for clients that support it, with CR/LF/quote/backslash neutralized. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function handleGET(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { id } = await context.params;

  const result = await getAttachmentForDownload(
    { pool, storage: getStorage() },
    { userId: gate.user.id, roles: gate.user.roles },
    id,
  );
  if (result.status === "denied") return new Response(null, { status: 404 });

  const headers = new Headers();
  headers.set("content-type", result.mime || "application/octet-stream");
  headers.set("content-disposition", contentDisposition(result.filename));
  headers.set("content-length", String(result.sizeBytes));
  // Attachments inherit parent visibility and are user-scoped — never cache in shared caches.
  headers.set("cache-control", "private, no-store");
  // §11 download gateway: even if the file were opened in place, or pulled in by a
  // <script>/<link> tag on another page, it can never run as script or style in our origin.
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", ATTACHMENT_DOWNLOAD_CSP);
  // Streamed straight from the object store — the file is never buffered whole in memory.
  return new Response(result.body, { status: 200, headers });
}

async function handleDELETE(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { id } = await context.params;

  const result = await removeAttachment(
    { pool, storage: getStorage() },
    { userId: gate.user.id, roles: gate.user.roles },
    id,
  );
  switch (result.status) {
    case "ok":
      return Response.json({ ok: true });
    case "not_found":
      return Response.json({ error: "attachment not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: "only the uploader can remove this attachment" }, { status: 403 });
    case "not_editable":
      return Response.json({ error: "attachments can only be removed while the item is editable" }, { status: 409 });
    case "already_removed":
      return Response.json({ error: "attachment already removed" }, { status: 409 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/attachments/[id]", handleGET);
export const DELETE = withSystemLog("/api/attachments/[id]", handleDELETE);

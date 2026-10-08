// Pure request-shape parsing for /api/admin/settings (INNOBOX_SPEC.md §14.3).
import { isDateFormat } from "@innobox/shared";
import type { AttachmentLimits } from "./store";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export interface SettingsPatch {
  dateFormat?: "eu" | "us";
  attachmentLimits?: AttachmentLimits;
}

const MAX_ATTACHMENTS_PER_ITEM = 50;
const MAX_UPLOAD_SIZE_MB = 200;
// The chunk size (and hence the max-upload floor) is 5 MB — the S3/MinIO multipart part minimum
// (§11). Below 5 MB a non-final part would be rejected by the object store on assembly.
const MIN_UPLOAD_SIZE_MB = 5;
const MIN_CHUNK_SIZE_MB = 5;

export function parseSettingsPatch(body: unknown): Parsed<SettingsPatch> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail("request body must be a JSON object");
  const rec = body as Record<string, unknown>;
  const value: SettingsPatch = {};

  if (rec.dateFormat !== undefined) {
    if (typeof rec.dateFormat !== "string" || !isDateFormat(rec.dateFormat)) return fail("dateFormat must be 'eu' or 'us'");
    value.dateFormat = rec.dateFormat;
  }

  if (rec.attachmentLimits !== undefined) {
    const limits = rec.attachmentLimits;
    if (typeof limits !== "object" || limits === null) return fail("attachmentLimits must be an object");
    const l = limits as Record<string, unknown>;
    if (typeof l.maxPerItem !== "number" || !Number.isInteger(l.maxPerItem) || l.maxPerItem < 1 || l.maxPerItem > MAX_ATTACHMENTS_PER_ITEM) {
      return fail(`maxPerItem must be an integer between 1 and ${MAX_ATTACHMENTS_PER_ITEM}`);
    }
    if (
      typeof l.maxUploadSizeMb !== "number" ||
      !Number.isInteger(l.maxUploadSizeMb) ||
      l.maxUploadSizeMb < MIN_UPLOAD_SIZE_MB ||
      l.maxUploadSizeMb > MAX_UPLOAD_SIZE_MB
    ) {
      return fail(`maxUploadSizeMb must be an integer between ${MIN_UPLOAD_SIZE_MB} and ${MAX_UPLOAD_SIZE_MB}`);
    }
    // chunkSizeMb (§11): 5 MB floor (S3 multipart part minimum) and never larger than the max
    // upload size (otherwise chunking could never trigger). Together these keep the two settings
    // jointly satisfiable — which is why the max-upload floor is also 5 MB.
    if (
      typeof l.chunkSizeMb !== "number" ||
      !Number.isInteger(l.chunkSizeMb) ||
      l.chunkSizeMb < MIN_CHUNK_SIZE_MB ||
      l.chunkSizeMb > l.maxUploadSizeMb
    ) {
      return fail(`chunkSizeMb must be an integer between ${MIN_CHUNK_SIZE_MB} and the max upload size (${l.maxUploadSizeMb} MB)`);
    }
    value.attachmentLimits = { maxPerItem: l.maxPerItem, maxUploadSizeMb: l.maxUploadSizeMb, chunkSizeMb: l.chunkSizeMb };
  }

  if (value.dateFormat === undefined && value.attachmentLimits === undefined) {
    return fail("request must include at least one of: dateFormat, attachmentLimits");
  }

  return { ok: true, value };
}

export function parseImpactAreaCreate(body: unknown): Parsed<{ name: string }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail("request body must be a JSON object");
  const name = (body as Record<string, unknown>).name;
  if (typeof name !== "string" || name.trim() === "") return fail("name is required");
  if (name.trim().length > 60) return fail("name must be at most 60 characters");
  return { ok: true, value: { name: name.trim() } };
}

export function parseImpactAreaPatch(body: unknown): Parsed<{ name?: string; active?: boolean }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail("request body must be a JSON object");
  const rec = body as Record<string, unknown>;
  const value: { name?: string; active?: boolean } = {};
  if (rec.name !== undefined) {
    if (typeof rec.name !== "string" || rec.name.trim() === "") return fail("name must be a non-blank string");
    if (rec.name.trim().length > 60) return fail("name must be at most 60 characters");
    value.name = rec.name.trim();
  }
  if (rec.active !== undefined) {
    if (typeof rec.active !== "boolean") return fail("active must be a boolean");
    value.active = rec.active;
  }
  if (value.name === undefined && value.active === undefined) return fail("request must include name and/or active");
  return { ok: true, value };
}

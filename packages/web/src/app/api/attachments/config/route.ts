// GET /api/attachments/config — client-facing upload config (INNOBOX_SPEC.md §11): the §14.3
// limits (so the browser knows when to chunk) plus `scanEnforced` — whether a scanner is
// currently reachable, which decides if the submission forms block submit until files are clean
// (§6.1/§6.2). When false the platform fails open. Auth-required (any authenticated user can
// upload); nothing here is namespace- or anonymity-sensitive.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { isScanAvailable } from "@/lib/clamav";
import { getAttachmentLimits } from "../../admin/settings/store";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const [limits, scanEnforced] = await Promise.all([getAttachmentLimits(pool), isScanAvailable()]);
  return Response.json({
    maxPerItem: limits.maxPerItem,
    maxUploadSizeMb: limits.maxUploadSizeMb,
    chunkSizeMb: limits.chunkSizeMb,
    scanEnforced,
  });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/attachments/config", handleGET);

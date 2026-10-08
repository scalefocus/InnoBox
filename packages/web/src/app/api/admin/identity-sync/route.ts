// GET /api/admin/identity-sync (INNOBOX_SPEC.md §14.10): the platform-admin "Identity sync" card —
// provisioned user/group counts, mapped groups that never arrived, the last accepted and last
// rejected SCIM request, and the one fixed explanation the counts select. PLATFORM ADMIN ONLY
// (403 for namespace admins and everyone else). Read-only and deliberately not audited: counts
// and group object ids, no personal data.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { handleIdentitySyncGet } from "./handler";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  return handleIdentitySyncGet(requirePlatformAdmin, pool);
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/identity-sync", handleGET);

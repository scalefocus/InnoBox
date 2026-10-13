// GET /api/admin/public-submissions/count (INNOBOX_SPEC.md §24.5, §24.9): `{ pending }` for the
// Administration console card's bubble. Platform admin only.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { countPendingPublicSubmissions } from "../store";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  return Response.json({ pending: await countPendingPublicSubmissions(pool) });
}

export const GET = withSystemLog("/api/admin/public-submissions/count", handleGET);

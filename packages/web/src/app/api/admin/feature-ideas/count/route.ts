// GET /api/admin/feature-ideas/count (INNOBOX_SPEC.md §38.5, §38.14): `{ pending, enabled }` for the
// Administration console card — its bubble and its switch. Platform admin only.
import { getFeatureIdeasEnabled } from "@innobox/shared";
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { countPendingIdeas } from "../../../feature-ideas/store";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const [pending, enabled] = await Promise.all([countPendingIdeas(pool), getFeatureIdeasEnabled(pool)]);
  return Response.json({ pending, enabled });
}

export const GET = withSystemLog("/api/admin/feature-ideas/count", handleGET);

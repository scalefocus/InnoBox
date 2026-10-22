// GET /api/admin/feature-ideas?tab=pending|planned|decided (INNOBOX_SPEC.md §38.5, §38.14): the
// review page's three tabs — pending proposals oldest first (with the merge targets and each
// proposer's widest audience), every planned entry in the §38.2 order with its votes (the seeded ones
// included, with no proposer), and the declined and merged proposals of the last 90 days. Platform
// admin only — 403 for anyone else.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { listAdminIdeas, type AdminTab } from "../../feature-ideas/store";

export const dynamic = "force-dynamic";

const TABS: readonly AdminTab[] = ["pending", "planned", "decided"];

async function handleGET(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const tab = new URL(req.url).searchParams.get("tab") ?? "pending";
  if (!(TABS as readonly string[]).includes(tab)) return Response.json({ error: "tab must be one of: pending, planned, decided" }, { status: 400 });
  return Response.json(await listAdminIdeas(pool, tab as AdminTab));
}

export const GET = withSystemLog("/api/admin/feature-ideas", handleGET);

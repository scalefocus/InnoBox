// GET /api/dashboard (INNOBOX_SPEC.md §13.2): visibility-filtered KPI tiles + spotlight
// cards for the Home page. Auth-required, no admin gate — every authenticated user sees
// their own visibility-scoped counts.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getDashboard } from "./store";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const dashboard = await getDashboard(pool, { userId: gate.user.id, roles: gate.user.roles });
  return Response.json(dashboard);
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/dashboard", handleGET);

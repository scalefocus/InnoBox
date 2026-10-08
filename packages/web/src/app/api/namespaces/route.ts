// GET /api/namespaces (INNOBOX_SPEC.md §6.1): the viewer's own non-archived namespace
// memberships, for the challenge submission form's namespace picker. Unlike
// /api/admin/namespaces (platform-admin only, full CRUD), this is open to any
// authenticated user and returns only what they may submit into.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { listNamespaces } from "../admin/store";
import { withSystemLog } from "@/lib/system-log";

async function handleGET(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const all = await listNamespaces(pool);
  const namespaces = all
    .filter((ns) => !ns.archivedAt && gate.user.roles.isMemberOf(ns.id))
    .map((ns) => ({ id: ns.id, slug: ns.slug, displayName: ns.displayName }));
  return Response.json({ namespaces });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/namespaces", handleGET);

// GET /api/implementation-board (INNOBOX_SPEC.md §46.13): the implementation board for the caller —
// any signed-in user. The five filters come from the query, parsed by the one shared parser (§46.5): a
// malformed id or a toggle value other than `1` is 400; a well-formed id that matches nothing gives
// empty columns, never an answer that tells an unknown value from a hidden one (invariant 2). Not on
// the §14.5 presence allowlist: an open board repeats this read every 30 seconds.
import { parseBoardQuery } from "@innobox/shared";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { getImplementationBoard } from "./store";

export const dynamic = "force-dynamic";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const parsed = parseBoardQuery(new URL(req.url).searchParams);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const board = await getImplementationBoard(pool, { userId: gate.user.id, roles: gate.user.roles }, parsed.value);
  return Response.json(board, { headers: { "Cache-Control": "no-store" } });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/implementation-board", handleGET);

// POST /api/ai/triage/:number/rerun (INNOBOX_SPEC.md §22.11): asks the worker for a fresh triage
// note. Namespace and platform admins only; the challenge must still be a triage subject and the
// task effective. Advisory — nothing about the challenge changes.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { webAi } from "@/lib/ai";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { rerunTriageNotes } from "../../store";

export const dynamic = "force-dynamic";

async function handlePOST(_req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  const digits = number.replace(/^CH-/i, "");
  if (!/^[1-9][0-9]{0,9}$/.test(digits)) return Response.json({ error: "challenge not found" }, { status: 404 });
  const result = await rerunTriageNotes(pool, webAi(), { userId: gate.user.id, roles: gate.user.roles }, digits);
  switch (result) {
    case "ok":
      return Response.json({ ok: true });
    case "not_found":
      return Response.json({ error: "challenge not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: "Only namespace admins can re-run triage notes" }, { status: 403 });
    case "unavailable":
      return Response.json({ error: "Triage notes can't be re-run for this challenge right now" }, { status: 409 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/ai/triage/[number]/rerun", handlePOST);

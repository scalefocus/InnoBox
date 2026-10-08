// Readiness (INNOBOX_SPEC.md §2): safe to receive traffic — the database answers.
// The deploy pipeline smoke-checks this route before going green (§2.3). Unauthenticated
// (orchestrator probe), so the body carries only the status word and the failing check's name;
// the exception detail (host, role, …) goes to the structured log, never the response.
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    await pool.query("select 1");
    return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error(
      JSON.stringify({ level: "error", msg: "readiness check failed", check: "database", error: String(err) }),
    );
    return Response.json(
      { status: "not_ready", check: "database" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}

// Readiness (INNOBOX_SPEC.md §2): safe to receive traffic — the database answers.
// The deploy pipeline smoke-checks this route before going green (§2.3).
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    await pool.query("select 1");
    return Response.json({ status: "ready" });
  } catch (err) {
    return Response.json(
      { status: "not_ready", error: String((err as Error).message ?? err) },
      { status: 503 },
    );
  }
}

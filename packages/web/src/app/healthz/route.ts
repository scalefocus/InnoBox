// Liveness (INNOBOX_SPEC.md §2): the process is up. No dependencies checked. Unauthenticated
// (orchestrator probe), so the body is only the status word — no version or other detail.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
}

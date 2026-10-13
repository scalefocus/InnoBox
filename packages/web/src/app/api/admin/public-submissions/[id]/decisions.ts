// Shared plumbing of the §24.5 decision routes (INNOBOX_SPEC.md §24.9): the platform-admin gate,
// the mutation rate limit, the id check, and the refusals every decision shares.
import { requirePlatformAdmin, type SessionUser } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isUuid } from "../../../challenges/validation";

export const NOT_FOUND = "submission not found";
export const ALREADY_DECIDED = "Another admin has already reviewed this submission.";

export type DecisionGate = { ok: true; user: SessionUser; id: string } | { ok: false; response: Response };

export async function decisionGate(context: { params: Promise<{ id: string }> }): Promise<DecisionGate> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return { ok: false, response: limited };
  const { id } = await context.params;
  if (!isUuid(id)) return { ok: false, response: Response.json({ error: NOT_FOUND }, { status: 404 }) };
  return { ok: true, user: gate.user, id };
}

/** not_found → 404, conflict → 409 (someone else decided first). */
export function refusal(status: "not_found" | "conflict"): Response {
  return status === "not_found"
    ? Response.json({ error: NOT_FOUND }, { status: 404 })
    : Response.json({ error: ALREADY_DECIDED, code: "already_decided" }, { status: 409 });
}

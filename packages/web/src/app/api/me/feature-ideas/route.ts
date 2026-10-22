// GET /api/me/feature-ideas (INNOBOX_SPEC.md §38.7, §38.14): the caller's own proposals, newest
// first — pending (with the text), planned (the published title and its votes), declined (the
// admin's note) and merged (the entry it joined, while that is still live) — plus the §38.6 name
// switch, for the profile's Feature ideas section. Always answered: the proposals switch (§38.11)
// closes proposing, not the list.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { getFeatureIdeasNamed, listOwnIdeas } from "../../feature-ideas/store";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const [ideas, named] = await Promise.all([listOwnIdeas(pool, gate.user.id), getFeatureIdeasNamed(pool, gate.user.id)]);
  return Response.json({ named, ideas });
}

export const GET = withSystemLog("/api/me/feature-ideas", handleGET);

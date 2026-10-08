// The GET /api/admin/identity-sync handler body (INNOBOX_SPEC.md §14.10), split from route.ts so
// the gated dbtest can drive it with a resolved guard: route.ts binds the real
// requirePlatformAdmin + pool (lib/auth pulls in next-auth, which does not load under the plain
// node test runner). Platform admins only — anyone else gets the guard's 403. Not audited.
import type { Pool } from "pg";
import type { Guard } from "../../../../lib/auth";
import { identitySyncSummary } from "./store";

export async function handleIdentitySyncGet(gate: () => Promise<Guard>, db: Pool): Promise<Response> {
  const guard = await gate();
  if (!guard.ok) return guard.response;
  return Response.json(await identitySyncSummary(db));
}

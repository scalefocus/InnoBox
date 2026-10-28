// GET /api/users?q=&challenge= (INNOBOX_SPEC.md §7.3): searchable directory of active users,
// for the namespace admin's assignment picker. Auth-required; returns id/displayName/email only —
// no role/namespace data (this isn't an admin-only endpoint). With `challenge=<number>` (the
// per-challenge pickers) only users who can see that challenge are returned. Which users those are
// reveals namespace membership and admin roles, so the filtered form answers only an admin of the
// challenge's namespace — the same gate as the assign endpoint; anyone else, and any challenge the
// caller cannot see or that does not exist, gets no users (§2.4 existence-not-disclosed).
//
// The §39.2 co-author pickers offer eligible people only, with one of `coAuthorFor=<CH-n | SOL-n>`
// (the Team panel — a member of the item), `canSee=<CH-n>` (the solution form) or
// `namespace=<slug>&visibility=org|namespace` (the challenge form). Every variant leaves out the
// caller; a caller who may not use the variant gets no users.
//
// The §40.2 invitation picker, `inviteFor=<CH-n>`, offers the people who can see that challenge under
// the full §4.3 predicate, leaving out the caller, everyone they already invited to it and anyone
// they can already see as an author there — and no users unless the caller can see the challenge and
// it accepts solutions.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getAssignmentAudience, getCoAuthorPickerAudience } from "../challenges/store";
import { getInvitePickerAudience } from "../challenges/invitations";
import { searchActiveUsers } from "./store";
import { withSystemLog } from "@/lib/system-log";
import { rateLimit } from "@/lib/rate-limit";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  // §2.4: the directory picker is a search/autocomplete read — the limited "search" bucket.
  const limited = rateLimit(gate.user.id, "search");
  if (limited) return limited;
  const searchParams = new URL(req.url).searchParams;
  const q = searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return Response.json({ users: [] });
  const viewer = { userId: gate.user.id, roles: gate.user.roles };

  const inviteFor = searchParams.get("inviteFor");
  if (inviteFor !== null) {
    const audience = await getInvitePickerAudience(pool, viewer, inviteFor);
    if (!audience) return Response.json({ users: [] });
    return Response.json({ users: await searchActiveUsers(pool, q, undefined, { ...audience, callerId: gate.user.id }) });
  }

  const coAuthorFor = searchParams.get("coAuthorFor");
  const canSee = searchParams.get("canSee");
  const namespaceSlug = searchParams.get("namespace");
  if (coAuthorFor !== null || canSee !== null || namespaceSlug !== null) {
    const audience = await getCoAuthorPickerAudience(pool, viewer, { coAuthorFor, canSee, namespaceSlug, visibility: searchParams.get("visibility") });
    if (!audience) return Response.json({ users: [] });
    return Response.json({ users: await searchActiveUsers(pool, q, undefined, { ...audience, callerId: gate.user.id }) });
  }

  const challenge = searchParams.get("challenge");
  if (challenge === null) return Response.json({ users: await searchActiveUsers(pool, q) });
  const audience = await getAssignmentAudience(pool, viewer, challenge.replace(/^CH-/i, ""));
  if (!audience) return Response.json({ users: [] });
  const users = await searchActiveUsers(pool, q, audience);
  return Response.json({ users });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/users", handleGET);

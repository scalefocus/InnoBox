// Server-side half of the §13.7 onboarding redirect (INNOBOX_SPEC.md §13.7): called from the root
// layout so an unseen user is sent to /quick-start BEFORE the requested page renders (an HTTP
// redirect, not a client-side bounce after the page has painted). The middleware cannot do this —
// it runs on the edge with no DB access — so it only forwards the pathname (PATHNAME_HEADER) and
// this node-layer check reads the session + `users.quick_start_seen_at`.
//
// Deliberately lighter than getSessionUser(): one indexed lookup, no role resolution and no
// presence stamp (the page's own API calls do those). Fails open on any error — the client shell
// still gates the route — so onboarding can never take a page down.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "./authOptions";
import { pool } from "./db";
import { isQuickStartExempt, PATHNAME_HEADER, QUICK_START_PATH, shouldRedirectToQuickStart } from "./quick-start";

/** The signed-in, active user's `quick_start_seen_at`; `undefined` when there is no such user. */
async function sessionQuickStartSeenAt(): Promise<Date | null | undefined> {
  const session = await getServerSession(authOptions);
  const oid = session?.oid;
  if (!oid) return undefined;
  const { rows } = await pool.query<{ quick_start_seen_at: Date | null; active: boolean }>(
    `select quick_start_seen_at, active from users where external_id = $1`,
    [oid],
  );
  const row = rows[0];
  if (!row || !row.active) return undefined;
  return row.quick_start_seen_at;
}

/** Redirects (throws Next's redirect) when the current request must go to /quick-start first. */
export async function enforceQuickStart(): Promise<void> {
  let pathname: string | null = null;
  let seenAt: Date | null | undefined;
  try {
    pathname = (await headers()).get(PATHNAME_HEADER);
    if (!pathname || isQuickStartExempt(pathname)) return; // no DB round-trip for exempt routes
    seenAt = await sessionQuickStartSeenAt();
  } catch {
    return; // fail open — the client shell's gate still applies
  }
  // Outside the try: redirect() works by throwing, which must not be swallowed above.
  if (shouldRedirectToQuickStart(pathname, seenAt)) redirect(QUICK_START_PATH);
}

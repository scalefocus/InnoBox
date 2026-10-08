// The §14.7 capture path bound to the real dependencies (INNOBOX_SPEC.md): `withSystemLog`
// wraps every API route handler; `recordUncaughtRequestError` is the instrumentation net. The
// wrapper's logic lives in lib/system-log-core.ts (pure, unit-tested with fakes).
import { getServerSession } from "next-auth";
import { pathWithoutQuery, sanitizeSystemMessage, type PathEntity } from "@innobox/shared";
import { authOptions } from "./authOptions";
import { pool } from "./db";
import { recordSystemEvent } from "../app/api/admin/system-log/store";
import { createSystemLogWrapper, type ActorSnapshot } from "./system-log-core";

export { INTERNAL_ERROR_MESSAGE, createSystemLogWrapper, type ActorSnapshot, type SystemLogDeps } from "./system-log-core";

// ── The real dependencies ────────────────────────────────────────────────────────────────

/** A light session read — the cookie's oid → one users row. Deliberately NOT getSessionUser():
 *  no role resolution and no presence stamp for an error we are merely recording. */
async function resolveActorFromSession(): Promise<ActorSnapshot | null> {
  const session = await getServerSession(authOptions);
  const oid = session?.oid;
  if (!oid) return null;
  const { rows } = await pool.query<{ id: string; display_name: string | null; email: string | null }>(
    `select id, display_name, email from users where external_id = $1`,
    [oid],
  );
  const row = rows[0];
  return row ? { userId: row.id, name: row.display_name, email: row.email } : null;
}

/** Anonymous, or missing → true (mask). A solution is masked when EITHER it or its parent
 *  challenge is anonymous, exactly like the §14.5 presence location labels. */
async function isAnonymousEntity(entity: PathEntity): Promise<boolean> {
  if (entity.kind === "challenge") {
    const { rows } = await pool.query<{ is_anonymous: boolean }>(`select is_anonymous from challenges where number = $1`, [entity.number]);
    return rows[0] ? rows[0].is_anonymous : true;
  }
  const { rows } = await pool.query<{ anonymous: boolean }>(
    `select (s.is_anonymous or c.is_anonymous) as anonymous
       from solutions s join challenges c on c.id = s.challenge_id
      where s.number = $1`,
    [entity.number],
  );
  return rows[0] ? rows[0].anonymous : true;
}

export const withSystemLog = createSystemLogWrapper({
  record: (event) => recordSystemEvent(pool, event),
  resolveActor: resolveActorFromSession,
  isAnonymousTarget: isAnonymousEntity,
});

/**
 * The net under the wrapper: Next's `onRequestError` hook (instrumentation.ts) for uncaught
 * errors on anything not wrapped — page renders, server actions. Best-effort, no user (the
 * hook has only raw headers), source `web`.
 */
export async function recordUncaughtRequestError(
  err: unknown,
  request: { path: string; method: string; headers?: Record<string, string | string[] | undefined> },
  context: { routePath?: string; routeType?: string },
): Promise<void> {
  const error = err instanceof Error ? err : new Error(String(err));
  const requestIdHeader = request.headers?.["x-request-id"];
  await recordSystemEvent(pool, {
    status: 500,
    method: request.method,
    route: context.routePath ?? pathWithoutQuery(request.path),
    // The hook sees only the raw path; without the matched template we cannot judge anonymity,
    // so the concrete path is dropped in favour of the route (mask by default).
    path: context.routePath ?? pathWithoutQuery(request.path),
    errorCode: context.routeType ? `uncaught_${context.routeType}` : "uncaught",
    message: sanitizeSystemMessage(error.message),
    requestId: typeof requestIdHeader === "string" ? requestIdHeader : null,
    source: "web",
  });
}

// The §14.7 route-wrapper CORE (INNOBOX_SPEC.md): pure of next-auth and pg imports so the unit
// test can drive it with fakes. lib/system-log.ts binds it to the real session + database.
// The §14.7 capture path (INNOBOX_SPEC.md): `withSystemLog(routeTemplate, handler)` wraps every
// API route handler and records, in the route's own context, both the error RESPONSES the
// handler returns and the errors it THROWS (stack to stdout, a JSON 500 to the client, a 500 row
// here). Next's `instrumentation.ts` onRequestError is the net for anything unwrapped.
//
// Three properties matter more than the data:
//   1. Fire-and-forget — the insert is never awaited and a logging failure can never turn a
//      response into a 500. The 2xx/3xx happy path pays nothing beyond a status check.
//   2. Privacy — never the body, headers, query string or stack; one sanitized line.
//   3. Anonymity (§9, the §14.5 rule) — when the request targeted an anonymous challenge or
//      solution, `path` stores the route template, never the concrete number; and it defaults
//      to masking whenever it cannot tell.
// And one gate before the handler: the §2.4 CSRF Origin rule runs here a second time, independently
// of the edge middleware (same rule, exemptions and 403 body, injected through `originAllowed`),
// so a request that skipped the middleware still finds CSRF enforced per route.
import {
  entityInPath,
  errorCodeForStatus,
  isClientDisconnect,
  pathWithoutQuery,
  sanitizeSystemMessage,
  shouldRecordSystemEvent,
  type PathEntity,
  type SystemEventInput,
} from "@innobox/shared";

export interface ActorSnapshot {
  userId: string;
  name: string | null;
  email: string | null;
}

export interface SystemLogDeps {
  record: (event: SystemEventInput) => Promise<void>;
  /** The signed-in user, if any — resolved only when something is being recorded. */
  resolveActor: () => Promise<ActorSnapshot | null>;
  /** True when the entity is anonymous OR cannot be found — masking is the default. */
  isAnonymousTarget: (entity: PathEntity) => Promise<boolean>;
  /** §2.4 CSRF, the second of the two independent checks: true when the request may reach the
   *  handler. Bound to the same Origin rule, exemptions and 403 body as the edge middleware, so a
   *  request that skipped the middleware still finds CSRF enforced per route. */
  originAllowed: (req: Request) => boolean;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
}

type Handler<A extends unknown[]> = (...args: A) => Response | Promise<Response>;

export interface SystemLogOptions {
  /** Record the row with NO user id and NO actor snapshot — the survey routes (§13.10): a named,
   *  exact-time row next to a date-only response would identify it. The session is not even read. */
  anonymousActor?: boolean;
}

/** What a handler wants recorded for its response instead of the defaults — the §22.5 AI admin
 *  routes, whose failed provider test answers 200 yet must reach the log with its diagnostic. */
export interface SystemEventNote {
  /** The row's status — defaults to the response's. */
  status?: number;
  errorCode?: string | null;
  /** Replaces the `{ error }` text. Sanitized at insert like any message. */
  message: string;
}

const notes = new WeakMap<Response, SystemEventNote>();

/**
 * Attaches a note to a response: the wrapper then records a row for it whatever its status (a 2xx
 * included), with the note's status, code and message. Nothing reaches the response itself, so a
 * diagnostic meant only for the system log never leaves the server. Returns the response.
 */
export function noteSystemEvent(res: Response, note: SystemEventNote): Response {
  notes.set(res, note);
  return res;
}

/** The user-facing 500 body for an unhandled throw. Deliberately generic — the detail is in the
 *  system log and stdout, never in the response. */
export const INTERNAL_ERROR_MESSAGE = "something went wrong on our side — please try again";

/** The §2.4 CSRF refusal — the same body and status the edge middleware answers with. */
export const CSRF_FORBIDDEN_MESSAGE = "forbidden";
export const csrfForbidden = (): Response => Response.json({ error: CSRF_FORBIDDEN_MESSAGE }, { status: 403 });

function requestOf(args: unknown[]): Request | null {
  const first = args[0];
  return first instanceof Request ? first : null;
}

/** Reads the `{ error }` message off a JSON error response without consuming the original. */
async function errorMessageOf(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as unknown;
    if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
      return (body as { error: string }).error;
    }
  } catch {
    /* not JSON — fall through */
  }
  return res.statusText || `HTTP ${res.status}`;
}

export function createSystemLogWrapper(deps: SystemLogDeps) {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: Record<string, unknown>) => console.error(JSON.stringify(line)));

  async function capture(
    template: string,
    req: Request | null,
    status: number,
    message: string,
    errorCode: string | null,
    startedAt: number,
    opts: SystemLogOptions,
  ): Promise<void> {
    const method = req?.method ?? "GET";
    const concretePath = req ? pathWithoutQuery(new URL(req.url).pathname) : template;
    let path = concretePath;
    const entity = entityInPath(template, concretePath);
    if (entity) {
      let mask = true;
      try {
        mask = await deps.isAnonymousTarget(entity);
      } catch {
        mask = true; // cannot tell → mask
      }
      if (mask) path = template;
    }
    let actor: ActorSnapshot | null = null;
    if (!opts.anonymousActor) {
      try {
        actor = await deps.resolveActor();
      } catch {
        actor = null;
      }
    }
    await deps.record({
      status,
      method,
      route: template,
      path,
      userId: actor?.userId ?? null,
      actorName: actor?.name ?? null,
      actorEmail: actor?.email ?? null,
      errorCode: errorCode ?? errorCodeForStatus(status),
      message: sanitizeSystemMessage(message),
      requestId: req?.headers.get("x-request-id") ?? null,
      durationMs: now() - startedAt,
      source: "web",
    });
  }

  /** The throw path: a client that hung up is logged at info and never recorded; anything else is
   *  a stack to stdout, a 500 row, and a generic JSON 500 to the client. */
  function onThrow(err: unknown, req: Request | null, template: string, startedAt: number, opts: SystemLogOptions): Response {
    // The client left before we answered: not an error anyone hit, so no row and no stack
    // (§14.7). The 500 below is written to a closed socket — nobody reads it.
    if (isClientDisconnect(err, req?.signal)) {
      log({ level: "info", msg: "client disconnected", route: template });
      return Response.json({ error: INTERNAL_ERROR_MESSAGE }, { status: 500 });
    }
    const error = err instanceof Error ? err : new Error(String(err));
    log({ level: "error", msg: "unhandled route error", route: template, error: error.message, stack: error.stack });
    void capture(template, req, 500, error.message, error.name && error.name !== "Error" ? error.name : null, startedAt, opts).catch(() => {});
    return Response.json({ error: INTERNAL_ERROR_MESSAGE }, { status: 500 });
  }

  return function withSystemLog<A extends unknown[]>(
    template: string,
    handler: Handler<A>,
    opts: SystemLogOptions = {},
  ): (...args: A) => Promise<Response> {
    return async (...args: A): Promise<Response> => {
      const startedAt = now();
      const req = requestOf(args);
      let res: Response;
      // §2.4 defence in depth: the Origin rule runs again here, before the handler, with the same
      // 403 body as the middleware. The refusal then flows through the recording below exactly
      // like a 403 the handler itself would have returned.
      if (req && !deps.originAllowed(req)) {
        res = csrfForbidden();
      } else {
        try {
          res = await handler(...args);
        } catch (err) {
          return onThrow(err, req, template, startedAt, opts);
        }
      }
      const note = notes.get(res);
      if (note) {
        void capture(template, req, note.status ?? res.status, note.message, note.errorCode ?? null, startedAt, opts).catch(() => {});
      } else if (shouldRecordSystemEvent(res.status)) {
        void (async () => {
          const message = await errorMessageOf(res);
          await capture(template, req, res.status, message, null, startedAt, opts);
        })().catch(() => {
          // Deliberately silent (property 1): a logging failure must never surface.
        });
      }
      return res;
    };
  };
}

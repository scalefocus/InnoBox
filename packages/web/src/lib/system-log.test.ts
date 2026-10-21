// Unit tests for the §14.7 route wrapper against fake dependencies: what gets recorded, what
// never does, the throw → 500 path, anonymity masking (and its mask-by-default fallback), and
// the fire-and-forget guarantee that a failing recorder never touches the response — and the §2.4
// CSRF re-check the wrapper runs before every handler (the second of the two independent checks).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SystemEventInput } from "@innobox/shared";
import { CSRF_FORBIDDEN_MESSAGE, INTERNAL_ERROR_MESSAGE, createSystemLogWrapper, noteSystemEvent, type SystemLogDeps } from "./system-log-core";
import { isRequestOriginAllowed } from "./csrf";

function fakeDeps(overrides: Partial<SystemLogDeps> = {}) {
  const recorded: SystemEventInput[] = [];
  const logged: Record<string, unknown>[] = [];
  const deps: SystemLogDeps = {
    record: async (e) => {
      recorded.push(e);
    },
    resolveActor: async () => ({ userId: "u-1", name: "Alice", email: "alice@example.test" }),
    isAnonymousTarget: async () => false,
    // The recording tests are about what happens AFTER the gate; the CSRF tests below bind the
    // real rule instead.
    originAllowed: () => true,
    log: (line) => {
      logged.push(line);
    },
    ...overrides,
  };
  return { deps, recorded, logged, withSystemLog: createSystemLogWrapper(deps) };
}

/** The recorder runs after the response is returned; yield to the microtask queue. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

const req = (method: string, url: string, headers: Record<string, string> = {}) => new Request(`http://innobox.test${url}`, { method, headers });

test("a 2xx response records nothing", async () => {
  const { recorded, withSystemLog } = fakeDeps();
  const GET = withSystemLog("/api/dashboard", async (_req: Request) => Response.json({ ok: true }));
  const res = await GET(req("GET", "/api/dashboard"));
  assert.equal(res.status, 200);
  await settle();
  assert.equal(recorded.length, 0);
});

test("401 and 404 are never recorded; 403/409/413/422/429 and 5xx are", async () => {
  const { recorded, withSystemLog } = fakeDeps();
  for (const status of [401, 404, 400]) {
    const H = withSystemLog("/api/x", async (_req: Request) => Response.json({ error: "no" }, { status }));
    await H(req("GET", "/api/x"));
  }
  await settle();
  assert.equal(recorded.length, 0);
  for (const status of [403, 409, 413, 422, 429, 500, 503]) {
    const H = withSystemLog("/api/x", async (_req: Request) => Response.json({ error: `status ${status}` }, { status }));
    await H(req("POST", "/api/x?secret=1"));
  }
  await settle();
  assert.deepEqual(
    recorded.map((e) => e.status),
    [403, 409, 413, 422, 429, 500, 503],
  );
  const first = recorded[0]!;
  assert.equal(first.method, "POST");
  assert.equal(first.route, "/api/x");
  assert.equal(first.path, "/api/x", "the query string is never stored");
  assert.equal(first.message, "status 403", "the handler's own error message is the row's message");
  assert.equal(first.errorCode, "forbidden");
  assert.equal(first.userId, "u-1");
  assert.equal(first.actorEmail, "alice@example.test");
  assert.equal(first.source, "web");
});

test("unrecordedStatuses: the monitoring beacon's 429 is never recorded, its 5xx still is (§14.12)", async () => {
  const { recorded, withSystemLog } = fakeDeps();
  for (const status of [429, 500]) {
    const H = withSystemLog("/api/rum", async (_req: Request) => Response.json({ error: `status ${status}` }, { status }), {
      anonymousActor: true,
      unrecordedStatuses: [429],
    });
    assert.equal((await H(req("POST", "/api/rum"))).status, status, "the response itself is unchanged");
  }
  await settle();
  assert.deepEqual(
    recorded.map((e) => [e.status, e.userId]),
    [[500, null]],
  );
});

test("the response body is left intact for the client after recording", async () => {
  const { withSystemLog } = fakeDeps();
  const H = withSystemLog("/api/x", async (_req: Request) => Response.json({ error: "forbidden here" }, { status: 403 }));
  const res = await H(req("GET", "/api/x"));
  await settle();
  assert.deepEqual(await res.json(), { error: "forbidden here" });
});

test("a thrown error becomes a generic JSON 500, is logged with its stack, and is recorded", async () => {
  const { recorded, logged, withSystemLog } = fakeDeps();
  const H = withSystemLog("/api/boom", async (_req: Request) => {
    throw new TypeError("db exploded\n    at somewhere");
  });
  const res = await H(req("GET", "/api/boom"));
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: INTERNAL_ERROR_MESSAGE });
  await settle();
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.level, "error");
  assert.ok(String(logged[0]!.stack).includes("at "), "the stack goes to stdout");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.status, 500);
  assert.equal(recorded[0]!.message, "db exploded", "one line, no stack, in the row");
  assert.equal(recorded[0]!.errorCode, "TypeError");
});

test("a client that hung up mid-request is logged at info and never recorded", async () => {
  const { recorded, logged, withSystemLog } = fakeDeps();
  const H = withSystemLog("/api/me/survey/check", async (_req: Request) => {
    throw Object.assign(new Error("aborted"), { code: "ECONNRESET" }); // what Node raises on the body read
  });
  await H(req("POST", "/api/me/survey/check"));
  await settle();
  assert.equal(recorded.length, 0, "no row, so no nav badge and no system.error alert");
  assert.deepEqual(logged, [{ level: "info", msg: "client disconnected", route: "/api/me/survey/check" }]);
});

test("a throw after the request's signal aborted is a disconnect too; the same throw otherwise is a 500 row", async () => {
  const { recorded, logged, withSystemLog } = fakeDeps();
  const H = withSystemLog("/api/admin/ai/test", async (_req: Request) => {
    throw new Error("stream closed");
  });
  await H(new Request("http://innobox.test/api/admin/ai/test", { method: "POST", signal: AbortSignal.abort() }));
  await settle();
  assert.equal(recorded.length, 0);
  assert.equal(logged[0]!.level, "info");
  await H(req("POST", "/api/admin/ai/test"));
  await settle();
  assert.equal(recorded.length, 1, "with the client still there it is a real failure");
  assert.equal(recorded[0]!.status, 500);
});

test("a numbered route targeting an anonymous item stores the template, not the number", async () => {
  const { recorded, withSystemLog } = fakeDeps({ isAnonymousTarget: async (e) => e.number === 412 });
  const H = withSystemLog("/api/challenges/[number]", async (_req: Request) => Response.json({ error: "nope" }, { status: 403 }));
  await H(req("PATCH", "/api/challenges/412"));
  await H(req("PATCH", "/api/challenges/7"));
  await settle();
  assert.equal(recorded[0]!.path, "/api/challenges/[number]", "anonymous → masked");
  assert.equal(recorded[1]!.path, "/api/challenges/7", "a named item keeps its number");
});

test("when anonymity cannot be determined the path is masked", async () => {
  const { recorded, withSystemLog } = fakeDeps({
    isAnonymousTarget: async () => {
      throw new Error("db down");
    },
  });
  const H = withSystemLog("/api/solutions/[number]/withdraw", async (_req: Request) => Response.json({ error: "x" }, { status: 409 }));
  await H(req("POST", "/api/solutions/88/withdraw"));
  await settle();
  assert.equal(recorded[0]!.path, "/api/solutions/[number]/withdraw");
});

test("a failing recorder or actor lookup never changes the response", async () => {
  const { withSystemLog } = fakeDeps({
    record: async () => {
      throw new Error("insert failed");
    },
    resolveActor: async () => {
      throw new Error("session lookup failed");
    },
  });
  const H = withSystemLog("/api/x", async (_req: Request) => Response.json({ error: "limited" }, { status: 429, headers: { "retry-after": "3" } }));
  const res = await H(req("POST", "/api/x"));
  await settle();
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "3");
});

test("a request id header is kept; a zero-argument handler still records method and path", async () => {
  const { recorded, withSystemLog } = fakeDeps();
  const H = withSystemLog("/api/me", async (_req: Request) => Response.json({ error: "slow down" }, { status: 429 }));
  // Next passes (request, context) at runtime even when the handler declares no parameters.
  await (H as unknown as (...a: unknown[]) => Promise<Response>)(req("PATCH", "/api/me", { "x-request-id": "req-123" }), {});
  await settle();
  assert.equal(recorded[0]!.requestId, "req-123");
  assert.equal(recorded[0]!.method, "PATCH");
  assert.equal(recorded[0]!.path, "/api/me");
  assert.ok((recorded[0]!.durationMs ?? -1) >= 0);
});

test("anonymousActor: the row carries no user id and no actor snapshot, and the session is never read (§13.10)", async () => {
  let resolved = 0;
  const { recorded, withSystemLog } = fakeDeps({
    resolveActor: async () => {
      resolved++;
      return { userId: "u-1", name: "Alice", email: "alice@example.test" };
    },
  });
  const POST = withSystemLog("/api/me/survey/responses", async (_req: Request) => Response.json({ error: "no_open_survey" }, { status: 409 }), {
    anonymousActor: true,
  });
  const THROWS = withSystemLog("/api/me/features/used", async (_req: Request): Promise<Response> => {
    throw new Error("boom");
  }, { anonymousActor: true });
  await POST(req("POST", "/api/me/survey/responses"));
  await THROWS(req("POST", "/api/me/features/used"));
  await settle();
  assert.equal(recorded.length, 2);
  for (const row of recorded) {
    assert.equal(row.userId, null);
    assert.equal(row.actorName, null);
    assert.equal(row.actorEmail, null);
  }
  assert.equal(resolved, 0);
});

test("a noted response is recorded with the note's status, code and message — even a 2xx — and the body is untouched (§22.5)", async () => {
  const { recorded, withSystemLog } = fakeDeps();
  const POST = withSystemLog("/api/admin/ai/test", async (_req: Request) =>
    noteSystemEvent(Response.json({ ok: false, error: "The connection to the AI provider failed." }), {
      status: 502,
      errorCode: "ai_provider_error",
      message: "AI test failed: The connection to the AI provider failed. — connecting to ai.example.com (10.0.0.5) failed: ECONNREFUSED\nsecond line",
    }),
  );
  const res = await POST(req("POST", "/api/admin/ai/test"));
  assert.equal(res.status, 200, "the client still gets the handler's response");
  const body = (await res.json()) as { error: string };
  assert.ok(!JSON.stringify(body).includes("ECONNREFUSED"), "the diagnostic never reaches the client");
  await settle();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.status, 502);
  assert.equal(recorded[0]!.errorCode, "ai_provider_error");
  assert.equal(recorded[0]!.message, "AI test failed: The connection to the AI provider failed. — connecting to ai.example.com (10.0.0.5) failed: ECONNREFUSED", "one sanitized line");
  assert.equal(recorded[0]!.route, "/api/admin/ai/test");
  assert.equal(recorded[0]!.userId, "u-1", "recorded as the admin");

  // A note on an error response replaces its message; with no status it keeps the response's.
  const PUT = withSystemLog("/api/admin/ai", async (_req: Request) =>
    noteSystemEvent(Response.json({ error: "The test failed, so nothing was saved" }, { status: 422 }), { errorCode: "ai_test_failed", message: "AI save test failed: x" }),
  );
  await PUT(req("PUT", "/api/admin/ai"));
  await settle();
  assert.equal(recorded.length, 2, "one row, never two");
  assert.deepEqual([recorded[1]!.status, recorded[1]!.errorCode, recorded[1]!.message], [422, "ai_test_failed", "AI save test failed: x"]);
});

// ── §2.4 CSRF: the wrapper's own Origin check, bound to the real rule ──────────────────────

const PROD = { PUBLIC_BASE_URL: "https://innobox.example.com", NODE_ENV: "production" };

/** The real rule with a fixed production environment, the way lib/system-log.ts binds it. */
function csrfDeps() {
  let handlerRuns = 0;
  const base = fakeDeps({ originAllowed: (r) => isRequestOriginAllowed(r, PROD) });
  const handler = async (_req: Request) => {
    handlerRuns += 1;
    return Response.json({ ok: true });
  };
  return { ...base, handler, runs: () => handlerRuns };
}

const prodReq = (method: string, path: string, headers: Record<string, string> = {}) =>
  new Request(`https://innobox.example.com${path}`, { method, headers });

test("§2.4: a POST without an Origin is refused with the middleware's 403 body and the handler never runs", async () => {
  const { withSystemLog, handler, runs, recorded } = csrfDeps();
  const POST = withSystemLog("/api/challenges", handler);
  const res = await POST(prodReq("POST", "/api/challenges"));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "forbidden" });
  assert.equal(CSRF_FORBIDDEN_MESSAGE, "forbidden");
  assert.equal(runs(), 0, "the handler is never invoked");
  await settle();
  assert.equal(recorded.length, 1, "the refusal is recorded like any other 403");
  assert.equal(recorded[0]!.status, 403);
  assert.equal(recorded[0]!.errorCode, "forbidden");
  assert.equal(recorded[0]!.route, "/api/challenges");
  assert.equal(recorded[0]!.message, "forbidden");
});

test("§2.4: a different or sibling-subdomain Origin is refused too", async () => {
  const { withSystemLog, handler, runs } = csrfDeps();
  const POST = withSystemLog("/api/challenges", handler);
  for (const origin of ["https://evil.example.com", "https://innobox.example.com.evil.test", "null"]) {
    const res = await POST(prodReq("POST", "/api/challenges", { origin }));
    assert.equal(res.status, 403, origin);
  }
  assert.equal(runs(), 0);
});

test("§2.4: a GET passes without any Origin", async () => {
  const { withSystemLog, handler, runs } = csrfDeps();
  const GET = withSystemLog("/api/challenges", handler);
  const res = await GET(prodReq("GET", "/api/challenges"));
  assert.equal(res.status, 200);
  assert.equal(runs(), 1);
});

test("§2.4: a POST with the right Origin runs the handler", async () => {
  const { withSystemLog, handler, runs, recorded } = csrfDeps();
  const POST = withSystemLog("/api/challenges", handler);
  const res = await POST(prodReq("POST", "/api/challenges", { origin: "https://innobox.example.com" }));
  assert.equal(res.status, 200);
  assert.equal(runs(), 1);
  await settle();
  assert.equal(recorded.length, 0);
});

test("§2.4: /api/auth/* and the CSP report sink are exempt; the agent-access routes are exempt by path, the consent POST is not", async () => {
  const { withSystemLog, handler, runs } = csrfDeps();
  for (const path of ["/api/auth/callback/azure-ad", "/api/auth/signin", "/api/csp-report", "/mcp", "/oauth/register", "/oauth/token", "/oauth/revoke"]) {
    const POST = withSystemLog(path, handler);
    const res = await POST(prodReq("POST", path));
    assert.equal(res.status, 200, `${path} must pass without an Origin`);
  }
  assert.equal(runs(), 7);
  const consent = withSystemLog("/oauth/consent", handler);
  assert.equal((await consent(prodReq("POST", "/oauth/consent"))).status, 403, "the consent form carries the session, so it keeps the check");
  assert.equal((await consent(prodReq("POST", "/oauth/consent", { origin: "https://innobox.example.com" }))).status, 200);
  // The exact-path sink exemption does not widen to a sub-path.
  assert.equal((await withSystemLog("/api/csp-report/x", handler)(prodReq("POST", "/api/csp-report/x"))).status, 403);
});

test("§2.4: the check applies to PUT, PATCH and DELETE alike, and a handler called without a Request is not gated", async () => {
  const { withSystemLog, handler, runs } = csrfDeps();
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    const H = withSystemLog("/api/challenges/[number]", handler);
    assert.equal((await H(prodReq(method, "/api/challenges/42"))).status, 403, method);
  }
  assert.equal(runs(), 0);
  const bare = withSystemLog("/api/x", async () => Response.json({ ok: true }));
  assert.equal((await bare()).status, 200);
});

// Unit tests for the §14.7 route wrapper against fake dependencies: what gets recorded, what
// never does, the throw → 500 path, anonymity masking (and its mask-by-default fallback), and
// the fire-and-forget guarantee that a failing recorder never touches the response.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SystemEventInput } from "@innobox/shared";
import { INTERNAL_ERROR_MESSAGE, createSystemLogWrapper, type SystemLogDeps } from "./system-log-core";

function fakeDeps(overrides: Partial<SystemLogDeps> = {}) {
  const recorded: SystemEventInput[] = [];
  const logged: Record<string, unknown>[] = [];
  const deps: SystemLogDeps = {
    record: async (e) => {
      recorded.push(e);
    },
    resolveActor: async () => ({ userId: "u-1", name: "Alice", email: "alice@example.test" }),
    isAnonymousTarget: async () => false,
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

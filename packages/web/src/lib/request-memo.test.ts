// Unit tests for the per-request memo behind getSessionUser (INNOBOX_SPEC.md §4.2 *Resolution*:
// at most once per request, never reused across requests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { requestMemo } from "./request-memo";

test("one request scope: the computation runs once, every caller shares its result", async () => {
  const memo = requestMemo<number>();
  const scope = {};
  let calls = 0;
  const compute = async () => ++calls;
  const [a, b, c] = await Promise.all([memo(scope, compute), memo(scope, compute), memo(scope, compute)]);
  assert.deepEqual([a, b, c], [1, 1, 1]);
  assert.equal(await memo(scope, compute), 1, "a later call in the same request still shares it");
  assert.equal(calls, 1);
});

test("two requests never share a resolution — a role change is visible on the very next request", async () => {
  const memo = requestMemo<string>();
  let role = "member";
  const compute = async () => role;
  assert.equal(await memo({}, compute), "member");
  role = "namespace_admin";
  assert.equal(await memo({}, compute), "namespace_admin");
});

test("no request scope (build, tests): nothing is memoized", async () => {
  const memo = requestMemo<number>();
  let calls = 0;
  await memo(null, async () => ++calls);
  await memo(null, async () => ++calls);
  assert.equal(calls, 2);
});

test("a failed resolution is not pinned for the rest of the request", async () => {
  const memo = requestMemo<string>();
  const scope = {};
  let calls = 0;
  await assert.rejects(memo(scope, async () => {
    calls++;
    throw new Error("db blip");
  }));
  assert.equal(await memo(scope, async () => (calls++, "ok")), "ok");
  assert.equal(calls, 2);
});

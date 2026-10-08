// Hermetic unit tests for the GDPR-erasure request parser (INNOBOX_SPEC.md §3, §16): every
// 400-worthy `reassignTo` shape is refused before the route touches the database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScrubRequest } from "./erasure-validation";

const ERASED = "6a2f6f3e-0000-4000-8000-000000000001";
const SUCCESSOR = "6a2f6f3e-0000-4000-8000-000000000002";

test("parseScrubRequest: an empty body, {} or reassignTo null keeps the no-successor erasure", () => {
  assert.deepEqual(parseScrubRequest({}, ERASED), { ok: true, value: { reassignTo: null } });
  assert.deepEqual(parseScrubRequest({ reassignTo: null }, ERASED), { ok: true, value: { reassignTo: null } });
  assert.deepEqual(parseScrubRequest({ unrelated: 1 }, ERASED), { ok: true, value: { reassignTo: null } });
});

test("parseScrubRequest: accepts a uuid successor, normalised to lower case", () => {
  assert.deepEqual(parseScrubRequest({ reassignTo: SUCCESSOR }, ERASED), { ok: true, value: { reassignTo: SUCCESSOR } });
  assert.deepEqual(parseScrubRequest({ reassignTo: SUCCESSOR.toUpperCase() }, ERASED), { ok: true, value: { reassignTo: SUCCESSOR } });
});

test("parseScrubRequest: rejects a reassignTo that is not a uuid", () => {
  for (const reassignTo of ["", "not-a-uuid", 42, true, {}, [SUCCESSOR], `${SUCCESSOR} `]) {
    const parsed = parseScrubRequest({ reassignTo }, ERASED);
    assert.equal(parsed.ok, false, `must reject ${JSON.stringify(reassignTo)}`);
  }
});

test("parseScrubRequest: rejects the user being erased as their own successor, whatever the case", () => {
  assert.equal(parseScrubRequest({ reassignTo: ERASED }, ERASED).ok, false);
  assert.equal(parseScrubRequest({ reassignTo: ERASED.toUpperCase() }, ERASED).ok, false);
  assert.equal(parseScrubRequest({ reassignTo: ERASED }, ERASED.toUpperCase()).ok, false);
});

test("parseScrubRequest: error messages carry no spec reference (user-facing)", () => {
  const parsed = parseScrubRequest({ reassignTo: "x" }, ERASED);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.ok(!parsed.error.includes("§"));
});

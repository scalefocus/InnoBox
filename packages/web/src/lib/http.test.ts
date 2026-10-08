// Unit tests for the §2.4 request-body helpers (INNOBOX_SPEC.md): size caps before buffering,
// the application/json requirement, and "not an object" as a 400.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readBytesLimited, readJsonObject } from "./http";

function jsonReq(body: string, headers: Record<string, string> = { "content-type": "application/json" }): Request {
  return new Request("http://localhost/api/x", { method: "POST", body, headers });
}

/** A body with no Content-Length (streamed), so only the running count can catch it. */
function streamedReq(totalBytes: number): Request {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      const n = Math.min(1024, totalBytes - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n));
    },
  });
  return new Request("http://localhost/api/x", { method: "PUT", body: stream, duplex: "half" } as RequestInit);
}

test("a JSON object body parses", async () => {
  const r = await readJsonObject(jsonReq(`{"a":1}`));
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value, { a: 1 });
});

test("charset parameters on the content type are accepted", async () => {
  const r = await readJsonObject(jsonReq(`{}`, { "content-type": "application/json; charset=utf-8" }));
  assert.ok(r.ok);
});

test("a non-JSON content type is 415 (a plain HTML form cannot forge a JSON body)", async () => {
  const r = await readJsonObject(jsonReq(`{"a":1}`, { "content-type": "text/plain" }));
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.response.status, 415);
});

test("null, arrays, scalars, and unparsable bodies are 400", async () => {
  for (const body of ["null", "[]", "1", `"x"`, "{not json"]) {
    const r = await readJsonObject(jsonReq(body));
    assert.ok(!r.ok, body);
    if (!r.ok) assert.equal(r.response.status, 400, body);
  }
});

test("an oversized declared Content-Length is 413 before reading", async () => {
  const r = await readJsonObject(jsonReq(`{}`, { "content-type": "application/json", "content-length": "99999999" }), 1024);
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.response.status, 413);
});

test("a streamed body is cut off once it passes the cap", async () => {
  const over = await readBytesLimited(streamedReq(10_000), 4096);
  assert.ok(!over.ok);
  if (!over.ok) assert.equal(over.response.status, 413);

  const under = await readBytesLimited(streamedReq(4096), 4096);
  assert.ok(under.ok);
  if (under.ok) assert.equal(under.value.byteLength, 4096);
});

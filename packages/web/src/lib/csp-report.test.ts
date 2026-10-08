// Pins the §2.4 CSP report sink (INNOBOX_SPEC.md, POST /api/csp-report): the accepted media types
// and shapes, the 64 KB cap, the per-IP rate limit, the fixed directive allowlist (an
// unauthenticated caller can never mint a label), and that a report is only ever counted.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  CSP_DIRECTIVE_LABELS,
  CSP_REPORT_MAX_BYTES,
  cspViolationCounts,
  directiveLabel,
  handleCspReport,
  methodNotAllowed,
  resetCspViolationCounts,
  violationLabels,
} from "./csp-report";
import { effectiveLimit, resetRateLimits } from "./rate-limit";

beforeEach(() => {
  resetRateLimits();
  resetCspViolationCounts();
});

const LEGACY = { "csp-report": { "document-uri": "https://x/secret?q=1", "effective-directive": "script-src-elem", "blocked-uri": "inline" } };
const BATCH = [
  { type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "https://evil/x.png" } },
  { type: "deprecation", body: { id: "x" } },
  { type: "csp-violation", body: { effectiveDirective: "Style-Src-Attr" } },
  { type: "csp-violation", body: { effectiveDirective: "made-up-directive" } },
];

function post(body: string, contentType: string | null, extra: Record<string, string> = {}): Request {
  const headers: Record<string, string> = { ...extra };
  if (contentType) headers["content-type"] = contentType;
  return new Request("http://localhost/api/csp-report", { method: "POST", headers, body });
}

function counts(): Record<string, number> {
  return Object.fromEntries(cspViolationCounts().map(({ directive, count }) => [directive, count]));
}

test("directiveLabel: lower-cased and allowlisted; everything else is 'other'", () => {
  assert.equal(directiveLabel("script-src"), "script-src");
  assert.equal(directiveLabel(" FRAME-ANCESTORS "), "frame-ancestors");
  assert.equal(directiveLabel("report-to"), "other");
  assert.equal(directiveLabel("script-src 'self'"), "other");
  assert.equal(directiveLabel(undefined), "other");
  assert.equal(directiveLabel(42), "other");
  assert.equal(CSP_DIRECTIVE_LABELS.size, 19);
});

test("violationLabels: the legacy body under application/csp-report or application/json", () => {
  assert.deepEqual(violationLabels("application/csp-report", LEGACY), ["script-src-elem"]);
  assert.deepEqual(violationLabels("application/json; charset=utf-8", LEGACY), ["script-src-elem"]);
  assert.deepEqual(violationLabels("application/csp-report", { "csp-report": {} }), ["other"]);
  // A Reporting API array under the legacy type, or a malformed legacy body, matches neither shape.
  assert.equal(violationLabels("application/csp-report", BATCH), null);
  assert.equal(violationLabels("application/csp-report", { "csp-report": "x" }), null);
  assert.equal(violationLabels("application/csp-report", { other: {} }), null);
  assert.equal(violationLabels("application/json", null), null);
  assert.equal(violationLabels("application/json", "string"), null);
});

test("violationLabels: the Reporting API batch counts only csp-violation entries", () => {
  assert.deepEqual(violationLabels("application/reports+json", BATCH), ["img-src", "style-src-attr", "other"]);
  assert.deepEqual(violationLabels("application/json", BATCH), ["img-src", "style-src-attr", "other"]);
  assert.deepEqual(violationLabels("application/reports+json", []), []);
  assert.deepEqual(violationLabels("application/reports+json", [{ type: "csp-violation" }, 7, null]), ["other"]);
  assert.equal(violationLabels("application/reports+json", LEGACY), null);
});

test("a legacy report → 204, empty body, counted once under its directive", async () => {
  const res = await handleCspReport(post(JSON.stringify(LEGACY), "application/csp-report"), "203.0.113.7");
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
  assert.deepEqual(counts(), { "script-src-elem": 1 });
});

test("a Reporting API batch of n violations counts n", async () => {
  const res = await handleCspReport(post(JSON.stringify(BATCH), "application/reports+json"), "203.0.113.7");
  assert.equal(res.status, 204);
  assert.deepEqual(counts(), { "img-src": 1, "style-src-attr": 1, other: 1 });
});

test("any other content type → 415, nothing counted", async () => {
  for (const ct of [null, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
    const res = await handleCspReport(post(JSON.stringify(LEGACY), ct), "203.0.113.7");
    assert.equal(res.status, 415, String(ct));
  }
  assert.deepEqual(counts(), {});
});

test("unparseable JSON or neither shape → 400, nothing counted", async () => {
  assert.equal((await handleCspReport(post("{not json", "application/csp-report"), "203.0.113.7")).status, 400);
  assert.equal((await handleCspReport(post('{"x":1}', "application/json"), "203.0.113.7")).status, 400);
  assert.equal((await handleCspReport(post("", "application/reports+json"), "203.0.113.7")).status, 400);
  assert.deepEqual(counts(), {});
});

test("64 KB cap: a declared Content-Length over the cap → 413 before reading; so is a longer body", async () => {
  const declared = await handleCspReport(
    post(JSON.stringify(LEGACY), "application/csp-report", { "content-length": String(CSP_REPORT_MAX_BYTES + 1) }),
    "203.0.113.7",
  );
  assert.equal(declared.status, 413);
  const pad = "x".repeat(CSP_REPORT_MAX_BYTES);
  const big = { "csp-report": { "effective-directive": "img-src", pad } };
  assert.equal((await handleCspReport(post(JSON.stringify(big), "application/csp-report"), "203.0.113.7")).status, 413);
  // A report just under the cap is accepted.
  const fits = { "csp-report": { "effective-directive": "img-src", pad: "x".repeat(CSP_REPORT_MAX_BYTES - 100) } };
  assert.equal((await handleCspReport(post(JSON.stringify(fits), "application/csp-report"), "203.0.113.7")).status, 204);
  assert.deepEqual(counts(), { "img-src": 1 });
});

test("rate limit: per client IP, 429 with Retry-After once the bucket is spent; other IPs unaffected", async () => {
  const limit = effectiveLimit("csp-report");
  const now = 1_000_000;
  for (let i = 0; i < limit; i++) {
    const res = await handleCspReport(post(JSON.stringify(LEGACY), "application/csp-report"), "203.0.113.7", now);
    assert.equal(res.status, 204);
  }
  const limited = await handleCspReport(post(JSON.stringify(LEGACY), "application/csp-report"), "203.0.113.7", now);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal((await handleCspReport(post(JSON.stringify(LEGACY), "application/csp-report"), "198.51.100.1", now)).status, 204);
  assert.deepEqual(counts(), { "script-src-elem": limit + 1 });
});

test("rate limit: callers with no determinable address share one bucket", async () => {
  const limit = effectiveLimit("csp-report");
  const now = 2_000_000;
  for (let i = 0; i < limit; i++) await handleCspReport(post("[]", "application/reports+json"), null, now);
  assert.equal((await handleCspReport(post("[]", "application/reports+json"), null, now)).status, 429);
});

test("the 120/minute budget", () => {
  assert.equal(effectiveLimit("csp-report", 1), 120);
});

test("a body stream that fails mid-read resolves to a fixed status, never a throw", async () => {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("aborted"));
    },
  });
  const req = new Request("http://localhost/api/csp-report", {
    method: "POST",
    headers: { "content-type": "application/csp-report" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const res = await handleCspReport(req, "203.0.113.7");
  assert.equal(res.status, 400);
});

test("every method but POST → 405 with Allow: POST", () => {
  const res = methodNotAllowed();
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

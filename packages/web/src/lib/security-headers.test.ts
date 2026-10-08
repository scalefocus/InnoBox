// Pins the §2.4 response-header values (INNOBOX_SPEC.md): the CSP directives, the nonce mechanics
// (no 'unsafe-inline' script source, ever), the dev-only relaxations, HSTS only over https, and
// the static header set next.config.ts attaches to every response.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATTACHMENT_DOWNLOAD_CSP,
  buildContentSecurityPolicy,
  canonicalBaseUrl,
  CSP_REPORT_GROUP,
  CSP_REPORT_PATH,
  generateNonce,
  HSTS_VALUE,
  isAttachmentDownload,
  reportingEndpoints,
  reportingOrigin,
  STATIC_SECURITY_HEADERS,
  strictTransportSecurity,
} from "./security-headers";

function directives(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) map.set(name, sources);
  }
  return map;
}

test("production CSP: exactly the §2.4 directives", () => {
  const d = directives(buildContentSecurityPolicy({ nonce: "abc123==", dev: false }));
  assert.deepEqual(d.get("default-src"), ["'self'"]);
  assert.deepEqual(d.get("script-src"), ["'self'", "'nonce-abc123=='", "'strict-dynamic'"]);
  assert.deepEqual(d.get("style-src"), ["'self'", "'unsafe-inline'"]);
  assert.deepEqual(d.get("img-src"), ["'self'", "data:", "blob:"]);
  assert.deepEqual(d.get("font-src"), ["'self'"]);
  assert.deepEqual(d.get("connect-src"), ["'self'"]);
  assert.deepEqual(d.get("object-src"), ["'none'"]);
  assert.deepEqual(d.get("base-uri"), ["'none'"]);
  assert.deepEqual(d.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(d.get("form-action"), ["'self'", "https://login.microsoftonline.com"]);
  assert.equal(d.size, 10);
});

test("no 'unsafe-inline' or 'unsafe-eval' script source in production", () => {
  const csp = buildContentSecurityPolicy({ nonce: "n", dev: false });
  const script = directives(csp).get("script-src")!;
  assert.ok(!script.includes("'unsafe-inline'"));
  assert.ok(!script.includes("'unsafe-eval'"));
  assert.ok(!/ws:|wss:/.test(csp));
});

test("dev adds 'unsafe-eval' and the HMR websocket, nothing else", () => {
  const d = directives(buildContentSecurityPolicy({ nonce: "n", dev: true }));
  assert.deepEqual(d.get("script-src"), ["'self'", "'nonce-n'", "'strict-dynamic'", "'unsafe-eval'"]);
  assert.deepEqual(d.get("connect-src"), ["'self'", "ws:", "wss:"]);
  assert.ok(!d.get("script-src")!.includes("'unsafe-inline'"));
});

test("report: appends report-uri + report-to naming the sink, and changes nothing else", () => {
  const plain = buildContentSecurityPolicy({ nonce: "n", dev: false });
  const reporting = buildContentSecurityPolicy({ nonce: "n", dev: false, report: true });
  const d = directives(reporting);
  assert.deepEqual(d.get("report-uri"), ["/api/csp-report"]);
  assert.deepEqual(d.get("report-to"), ["csp"]);
  assert.equal(d.size, 12);
  assert.equal(reporting, `${plain}; report-uri ${CSP_REPORT_PATH}; report-to ${CSP_REPORT_GROUP}`);
  assert.ok(!/report-/.test(plain));
});

test("Reporting-Endpoints: the canonical origin, the request origin only in dev, else none", () => {
  assert.equal(reportingOrigin("https://innobox.example.com/some/path", "http://web:3000", false), "https://innobox.example.com");
  assert.equal(reportingOrigin("https://innobox.example.com", "http://localhost:3000", true), "https://innobox.example.com");
  assert.equal(reportingOrigin(undefined, "http://localhost:3000", true), "http://localhost:3000");
  assert.equal(reportingOrigin(undefined, "http://web:3000", false), null);
  assert.equal(reportingOrigin("not a url", "http://web:3000", false), null);
  assert.equal(reportingEndpoints("https://innobox.example.com"), 'csp="https://innobox.example.com/api/csp-report"');
});

test("without a nonce, scripts are same-origin only (no 'strict-dynamic' without a nonce to anchor it)", () => {
  const d = directives(buildContentSecurityPolicy({ dev: false }));
  assert.deepEqual(d.get("script-src"), ["'self'"]);
});

test("generateNonce: base64 of 128 random bits, fresh every call", () => {
  const a = generateNonce();
  const b = generateNonce();
  assert.match(a, /^[A-Za-z0-9+/]{22}==$/);
  assert.notEqual(a, b);
});

test("HSTS only when the canonical URL is https", () => {
  assert.equal(strictTransportSecurity("https://innobox.example.com"), HSTS_VALUE);
  assert.equal(HSTS_VALUE, "max-age=31536000");
  assert.equal(strictTransportSecurity("http://localhost:3000"), null);
  assert.equal(strictTransportSecurity(undefined), null);
  assert.equal(strictTransportSecurity("not a url"), null);
});

test("canonicalBaseUrl: PUBLIC_BASE_URL, falling back to NEXTAUTH_URL", () => {
  assert.equal(canonicalBaseUrl({ PUBLIC_BASE_URL: "https://a.example.com", NEXTAUTH_URL: "https://b.example.com" }), "https://a.example.com");
  assert.equal(canonicalBaseUrl({ PUBLIC_BASE_URL: "", NEXTAUTH_URL: "https://b.example.com" }), "https://b.example.com");
  assert.equal(canonicalBaseUrl({}), undefined);
});

test("static headers: nosniff, DENY, referrer policy, COOP, and the permissions denial", () => {
  const byName = new Map(STATIC_SECURITY_HEADERS.map((h) => [h.key.toLowerCase(), h.value]));
  assert.equal(byName.get("x-content-type-options"), "nosniff");
  assert.equal(byName.get("x-frame-options"), "DENY");
  assert.equal(byName.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(byName.get("cross-origin-opener-policy"), "same-origin");
  const pp = byName.get("permissions-policy")!;
  for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) {
    assert.ok(pp.includes(`${feature}=()`), `${feature} denied`);
  }
  // CSP and HSTS are per-request (middleware), never static.
  assert.ok(!byName.has("content-security-policy"));
  assert.ok(!byName.has("strict-transport-security"));
});

test("attachment downloads get the sandbox CSP, nothing else does", () => {
  assert.equal(ATTACHMENT_DOWNLOAD_CSP, "sandbox; default-src 'none'");
  assert.equal(isAttachmentDownload("GET", "/api/attachments/3f1c2a9e-0000-4000-8000-000000000000"), true);
  assert.equal(isAttachmentDownload("HEAD", "/api/attachments/3f1c2a9e-0000-4000-8000-000000000000"), true);
  assert.equal(isAttachmentDownload("DELETE", "/api/attachments/3f1c2a9e-0000-4000-8000-000000000000"), false);
  assert.equal(isAttachmentDownload("GET", "/api/attachments/config"), false);
  assert.equal(isAttachmentDownload("GET", "/api/attachments"), false);
  assert.equal(isAttachmentDownload("GET", "/api/attachments/uploads/x/complete"), false);
  assert.equal(isAttachmentDownload("GET", "/challenges/12"), false);
});

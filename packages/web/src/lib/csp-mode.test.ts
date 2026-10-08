// Pins the §2.4 CSP_MODE switch and its §2.3 fail-loud startup check (INNOBOX_SPEC.md): enforce
// (default) | report-only | off; off or an unrecognised value refuses to start in a production
// build; the attachment-download sandbox policy is enforced in every mode.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cspModeStartupCheck, cspResponseHeaders, resolveCspMode, type CspMode } from "./csp-mode";

test("resolveCspMode: unset or blank is enforce; the three modes are exact", () => {
  assert.deepEqual(resolveCspMode(undefined), { mode: "enforce", unrecognised: false });
  assert.deepEqual(resolveCspMode(""), { mode: "enforce", unrecognised: false });
  assert.deepEqual(resolveCspMode("  "), { mode: "enforce", unrecognised: false });
  assert.deepEqual(resolveCspMode("enforce"), { mode: "enforce", unrecognised: false });
  assert.deepEqual(resolveCspMode(" report-only "), { mode: "report-only", unrecognised: false });
  assert.deepEqual(resolveCspMode("off"), { mode: "off", unrecognised: false });
});

test("resolveCspMode: an unrecognised value is treated as enforce, and flagged", () => {
  for (const v of ["OFF", "reportonly", "report_only", "none", "false", "0"]) {
    assert.deepEqual(resolveCspMode(v), { mode: "enforce", unrecognised: true }, v);
  }
});

test("startup: a production build refuses to start on off or an unrecognised value, naming the variable", () => {
  for (const v of ["off", "bogus"]) {
    const r = cspModeStartupCheck({ NODE_ENV: "production", CSP_MODE: v });
    assert.ok(r.fatal, v);
    const line = JSON.parse(r.fatal!) as { level: string; variable: string; msg: string };
    assert.equal(line.level, "fatal");
    assert.equal(line.variable, "CSP_MODE");
    assert.ok(!line.msg.includes("bogus"), "the raw value is not echoed");
    assert.equal(r.warning, null);
  }
});

test("startup: production starts with enforce, report-only, or unset", () => {
  for (const v of [undefined, "", "enforce", "report-only"]) {
    assert.deepEqual(cspModeStartupCheck({ NODE_ENV: "production", CSP_MODE: v }), { fatal: null, warning: null }, String(v));
  }
});

test("startup: outside production off is allowed, and an unrecognised value only warns", () => {
  assert.deepEqual(cspModeStartupCheck({ NODE_ENV: "development", CSP_MODE: "off" }), { fatal: null, warning: null });
  assert.deepEqual(cspModeStartupCheck({ NODE_ENV: "test", CSP_MODE: "off" }), { fatal: null, warning: null });
  const r = cspModeStartupCheck({ NODE_ENV: "development", CSP_MODE: "bogus" });
  assert.equal(r.fatal, null);
  const line = JSON.parse(r.warning!) as { level: string; variable: string };
  assert.equal(line.level, "warn");
  assert.equal(line.variable, "CSP_MODE");
});

const POLICY = "default-src 'self'; report-uri /api/csp-report; report-to csp";
const ENDPOINTS = 'csp="https://innobox.example.com/api/csp-report"';
const SANDBOX = "sandbox; default-src 'none'";

function headersFor(mode: CspMode, attachment = false) {
  return cspResponseHeaders({ mode, policy: POLICY, attachmentPolicy: attachment ? SANDBOX : null, reportingEndpoints: ENDPOINTS });
}

test("enforce: the policy is the enforcing header, with Reporting-Endpoints", () => {
  assert.deepEqual(headersFor("enforce"), {
    "Content-Security-Policy": POLICY,
    "Content-Security-Policy-Report-Only": null,
    "Reporting-Endpoints": ENDPOINTS,
  });
});

test("report-only: the identical policy as Report-Only, and NO enforcing header", () => {
  assert.deepEqual(headersFor("report-only"), {
    "Content-Security-Policy": null,
    "Content-Security-Policy-Report-Only": POLICY,
    "Reporting-Endpoints": ENDPOINTS,
  });
});

test("off: neither CSP header nor Reporting-Endpoints", () => {
  assert.deepEqual(headersFor("off"), {
    "Content-Security-Policy": null,
    "Content-Security-Policy-Report-Only": null,
    "Reporting-Endpoints": null,
  });
});

test("the attachment-download sandbox policy is enforced in every mode", () => {
  for (const mode of ["enforce", "report-only", "off"] as const) {
    assert.deepEqual(headersFor(mode, true), {
      "Content-Security-Policy": SANDBOX,
      "Content-Security-Policy-Report-Only": null,
      "Reporting-Endpoints": null,
    }, mode);
  }
});

test("no Reporting-Endpoints when no origin could be determined", () => {
  const h = cspResponseHeaders({ mode: "enforce", policy: POLICY, attachmentPolicy: null, reportingEndpoints: null });
  assert.equal(h["Reporting-Endpoints"], null);
  assert.equal(h["Content-Security-Policy"], POLICY);
});

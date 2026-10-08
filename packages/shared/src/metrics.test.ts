import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMetrics, metricsAuthorized, type MetricSample } from "./metrics.js";

test("renderMetrics: groups same-named samples under one HELP/TYPE header, in first-seen order", () => {
  const samples: MetricSample[] = [
    { name: "innobox_up", help: "up", type: "gauge", value: 1, labels: { service: "web" } },
    { name: "innobox_build_info", help: "build", type: "gauge", value: 1, labels: { version: "0.14.0", service: "web" } },
    { name: "innobox_up", help: "up", type: "gauge", value: 1, labels: { service: "worker" } },
  ];
  const out = renderMetrics(samples);
  assert.match(out, /# HELP innobox_up up\n# TYPE innobox_up gauge\ninnobox_up\{service="web"\} 1\ninnobox_up\{service="worker"\} 1/);
  assert.match(out, /# HELP innobox_build_info build\n# TYPE innobox_build_info gauge\ninnobox_build_info\{version="0\.14\.0",service="web"\} 1/);
  // exactly one HELP line per metric name
  assert.equal((out.match(/# HELP innobox_up /g) ?? []).length, 1);
  assert.ok(out.endsWith("\n"));
});

test("renderMetrics: a sample with no labels emits a bare name", () => {
  const out = renderMetrics([{ name: "innobox_process_uptime_seconds", help: "uptime", type: "gauge", value: 42 }]);
  assert.match(out, /\ninnobox_process_uptime_seconds 42\n/);
});

test("renderMetrics: label values are escaped (backslash, quote, newline)", () => {
  const out = renderMetrics([{ name: "x", help: "h", type: "gauge", value: 1, labels: { l: 'a"b\\c\nd' } }]);
  assert.match(out, /x\{l="a\\"b\\\\c\\nd"\} 1/);
});

test("metricsAuthorized: open when no token is configured (dev)", () => {
  assert.equal(metricsAuthorized(null, undefined), true);
  assert.equal(metricsAuthorized(undefined, ""), true);
  assert.equal(metricsAuthorized("Bearer anything", null), true);
});

test("metricsAuthorized: requires an exact bearer match when a token is set", () => {
  assert.equal(metricsAuthorized("Bearer s3cret", "s3cret"), true);
  assert.equal(metricsAuthorized("Bearer wrong", "s3cret"), false);
  assert.equal(metricsAuthorized("s3cret", "s3cret"), false); // missing "Bearer " prefix
  assert.equal(metricsAuthorized(null, "s3cret"), false);
  assert.equal(metricsAuthorized("", "s3cret"), false);
});

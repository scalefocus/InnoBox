import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMetrics, metricsAccess, type MetricSample } from "./metrics.js";

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

const gate = (authorization: string | null | undefined, token: string | null | undefined, nodeEnv?: string) =>
  metricsAccess({ authorization, token, nodeEnv });

test("metricsAccess: open when no token is configured outside production (dev)", () => {
  assert.equal(gate(null, undefined), "allow");
  assert.equal(gate(undefined, "", "development"), "allow");
  assert.equal(gate("Bearer anything", null, "test"), "allow");
});

test("metricsAccess: disabled (404) in production when no token is configured", () => {
  assert.equal(gate(null, undefined, "production"), "disabled");
  assert.equal(gate("Bearer anything", "", "production"), "disabled");
});

test("metricsAccess: requires an exact bearer match when a token is set", () => {
  for (const env of [undefined, "development", "production"]) {
    assert.equal(gate("Bearer s3cret", "s3cret", env), "allow");
    assert.equal(gate("Bearer wrong", "s3cret", env), "unauthorized");
    assert.equal(gate("s3cret", "s3cret", env), "unauthorized"); // missing "Bearer " prefix
    assert.equal(gate(null, "s3cret", env), "unauthorized");
    assert.equal(gate("", "s3cret", env), "unauthorized");
  }
});

test("metricsAccess: a prefix or extension of the token is rejected (no length short-cut)", () => {
  assert.equal(gate("Bearer s3cre", "s3cret"), "unauthorized");
  assert.equal(gate("Bearer s3cret2", "s3cret"), "unauthorized");
  assert.equal(gate("Bearer s3cret ", "s3cret"), "unauthorized");
});

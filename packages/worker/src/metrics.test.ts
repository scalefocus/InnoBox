import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { renderMetrics } from "@innobox/shared";
import {
  createMetricsHandler,
  createReadyzHandler,
  healthzHandler,
  recordNotificationSweep,
  recordScanSweep,
  setLeader,
  workerMetricsSamples,
  resetWorkerMetrics,
  type MetricsEnv,
} from "./metrics.js";

function metricsApp(env: MetricsEnv) {
  const app = express();
  app.get("/metrics", createMetricsHandler(() => env));
  return app;
}

test("worker /metrics: token set → 401 without/with a wrong bearer, 200 with the right one", async () => {
  const app = metricsApp({ METRICS_TOKEN: "m3trics-token", NODE_ENV: "production" });
  assert.equal((await request(app).get("/metrics")).status, 401);
  assert.equal((await request(app).get("/metrics").set("Authorization", "Bearer nope")).status, 401);
  const ok = await request(app).get("/metrics").set("Authorization", "Bearer m3trics-token");
  assert.equal(ok.status, 200);
  assert.match(ok.text, /innobox_up\{service="worker"\} 1/);
});

test("worker /metrics: token unset → open in dev, 404 in production", async () => {
  assert.equal((await request(metricsApp({ NODE_ENV: "development" })).get("/metrics")).status, 200);
  assert.equal((await request(metricsApp({})).get("/metrics")).status, 200);
  const prod = await request(metricsApp({ NODE_ENV: "production" })).get("/metrics");
  assert.equal(prod.status, 404);
  assert.doesNotMatch(prod.text, /innobox_/);
});

test("worker /healthz: only the status word", async () => {
  const app = express();
  app.get("/healthz", healthzHandler);
  const res = await request(app).get("/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: "ok" });
});

test("worker /readyz: ok, not-leader, and a DB failure that never leaks the error message", async () => {
  const build = (pingDb: () => Promise<unknown>, leader: boolean) => {
    const app = express();
    app.get("/readyz", createReadyzHandler({ pingDb, isLeader: () => leader }));
    return app;
  };
  const ok = await request(build(async () => 1, true)).get("/readyz");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { status: "ok" });

  const follower = await request(build(async () => 1, false)).get("/readyz");
  assert.equal(follower.status, 503);
  assert.deepEqual(follower.body, { status: "not_ready", check: "leader" });

  const secretDetail = 'password authentication failed for user "innobox_app" at db.internal:5432';
  const origError = console.error;
  console.error = () => {}; // the detail is logged, not returned — silence it for the test run
  try {
    const down = await request(
      build(async () => {
        throw new Error(secretDetail);
      }, true),
    ).get("/readyz");
    assert.equal(down.status, 503);
    assert.deepEqual(down.body, { status: "not_ready", check: "database" });
    assert.equal(down.text.includes("innobox_app"), false);
  } finally {
    console.error = origError;
  }
});

function sampleValue(name: string): number {
  const s = workerMetricsSamples().find((x) => x.name === name);
  if (!s) throw new Error(`no sample ${name}`);
  return s.value;
}

test("worker metrics: sweeps accumulate into counters and leader gauge reflects state", () => {
  resetWorkerMetrics();

  // Baseline: counters zero, not leader, build/up present.
  assert.equal(sampleValue("innobox_notifications_sent_total"), 0);
  assert.equal(sampleValue("innobox_attachment_scans_infected_total"), 0);
  assert.equal(sampleValue("innobox_worker_leader"), 0);
  assert.equal(sampleValue("innobox_up"), 1);

  recordNotificationSweep({ sent: 3, failed: 1 });
  recordNotificationSweep({ sent: 2, failed: 0 });
  recordScanSweep({ clean: 4, infected: 1, unscannable: 1, errors: 2 });
  setLeader(true);

  assert.equal(sampleValue("innobox_notifications_sent_total"), 5);
  assert.equal(sampleValue("innobox_notifications_failed_total"), 1);
  assert.equal(sampleValue("innobox_attachment_scans_clean_total"), 4);
  assert.equal(sampleValue("innobox_attachment_scans_infected_total"), 1);
  assert.equal(sampleValue("innobox_attachment_scans_unscannable_total"), 1);
  assert.equal(sampleValue("innobox_attachment_scan_errors_total"), 2);
  assert.equal(sampleValue("innobox_worker_leader"), 1);

  setLeader(false);
  assert.equal(sampleValue("innobox_worker_leader"), 0);

  // Renders to valid Prometheus text with the worker service label + counter TYPE headers.
  const text = renderMetrics(workerMetricsSamples());
  assert.match(text, /innobox_build_info\{version="[^"]+",service="worker"\} 1/);
  assert.match(text, /# TYPE innobox_notifications_sent_total counter/);

  resetWorkerMetrics();
});

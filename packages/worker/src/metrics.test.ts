import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMetrics } from "@innobox/shared";
import { recordNotificationSweep, recordScanSweep, setLeader, workerMetricsSamples, resetWorkerMetrics } from "./metrics.js";

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
  recordScanSweep({ clean: 4, infected: 1, errors: 2 });
  setLeader(true);

  assert.equal(sampleValue("innobox_notifications_sent_total"), 5);
  assert.equal(sampleValue("innobox_notifications_failed_total"), 1);
  assert.equal(sampleValue("innobox_attachment_scans_clean_total"), 4);
  assert.equal(sampleValue("innobox_attachment_scans_infected_total"), 1);
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

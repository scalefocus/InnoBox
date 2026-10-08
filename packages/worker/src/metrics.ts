// Worker metrics (INNOBOX_SPEC.md §2, observability): process-lifetime counters/gauges the worker
// exposes at /metrics. Kept here (not in index.ts) so the sample-building is unit-testable. The
// sweep loops in index.ts call the record* functions; leadership calls setLeader.
import { APP_VERSION } from "@innobox/shared/version";
import { type MetricSample } from "@innobox/shared";

const counters = {
  notificationsSent: 0,
  notificationsFailed: 0,
  scansClean: 0,
  scansInfected: 0,
  scanErrors: 0,
};
let leader = false;

export function setLeader(isLeader: boolean): void {
  leader = isLeader;
}

export function recordNotificationSweep(summary: { sent?: number; failed?: number }): void {
  counters.notificationsSent += summary.sent ?? 0;
  counters.notificationsFailed += summary.failed ?? 0;
}

export function recordScanSweep(summary: { clean?: number; infected?: number; errors?: number }): void {
  counters.scansClean += summary.clean ?? 0;
  counters.scansInfected += summary.infected ?? 0;
  counters.scanErrors += summary.errors ?? 0;
}

/** For tests: reset all accumulated state. */
export function resetWorkerMetrics(): void {
  counters.notificationsSent = 0;
  counters.notificationsFailed = 0;
  counters.scansClean = 0;
  counters.scansInfected = 0;
  counters.scanErrors = 0;
  leader = false;
}

export function workerMetricsSamples(): MetricSample[] {
  const mem = process.memoryUsage();
  return [
    { name: "innobox_build_info", help: "Build/version info (always 1)", type: "gauge", value: 1, labels: { version: APP_VERSION, service: "worker" } },
    { name: "innobox_up", help: "1 if the service is up", type: "gauge", value: 1, labels: { service: "worker" } },
    { name: "innobox_process_resident_memory_bytes", help: "Resident set size in bytes", type: "gauge", value: mem.rss, labels: { service: "worker" } },
    { name: "innobox_process_heap_used_bytes", help: "V8 heap used in bytes", type: "gauge", value: mem.heapUsed, labels: { service: "worker" } },
    { name: "innobox_process_uptime_seconds", help: "Process uptime in seconds", type: "gauge", value: Math.round(process.uptime()), labels: { service: "worker" } },
    { name: "innobox_worker_leader", help: "1 when this worker holds the leader lock", type: "gauge", value: leader ? 1 : 0 },
    { name: "innobox_notifications_sent_total", help: "Notification e-mails sent by the outbox sweep", type: "counter", value: counters.notificationsSent },
    { name: "innobox_notifications_failed_total", help: "Notification e-mails that failed to send", type: "counter", value: counters.notificationsFailed },
    { name: "innobox_attachment_scans_clean_total", help: "Attachments the scan sweep marked clean", type: "counter", value: counters.scansClean },
    { name: "innobox_attachment_scans_infected_total", help: "Attachments the scan sweep marked infected", type: "counter", value: counters.scansInfected },
    { name: "innobox_attachment_scan_errors_total", help: "Attachment scan sweep transient errors", type: "counter", value: counters.scanErrors },
  ];
}

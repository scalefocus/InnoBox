// Worker metrics (INNOBOX_SPEC.md §2, observability): process-lifetime counters/gauges the worker
// exposes at /metrics, plus the /metrics, /healthz, and /readyz handlers. Kept here (not in
// index.ts) so the sample-building and the probe responses are unit-testable. The sweep loops in
// index.ts call the record* functions; leadership calls setLeader.
import { APP_VERSION } from "@innobox/shared/version";
import { metricsAccess, renderMetrics, type MetricSample } from "@innobox/shared";
import type { Request, Response } from "express";

const counters = {
  notificationsSent: 0,
  notificationsFailed: 0,
  scansClean: 0,
  scansInfected: 0,
  scansUnscannable: 0,
  scanErrors: 0,
};
/** §12.4 channel-webhook delivery outcomes, by `outcome` label. */
const webhookDeliveries = { sent: 0, failed: 0, skipped: 0 };
let leader = false;

export function setLeader(isLeader: boolean): void {
  leader = isLeader;
}

export function recordNotificationSweep(summary: { sent?: number; failed?: number }): void {
  counters.notificationsSent += summary.sent ?? 0;
  counters.notificationsFailed += summary.failed ?? 0;
}

export function recordWebhookSweep(summary: { sent?: number; failed?: number; skipped?: number }): void {
  webhookDeliveries.sent += summary.sent ?? 0;
  webhookDeliveries.failed += summary.failed ?? 0;
  webhookDeliveries.skipped += summary.skipped ?? 0;
}

export function recordScanSweep(summary: { clean?: number; infected?: number; unscannable?: number; errors?: number }): void {
  counters.scansClean += summary.clean ?? 0;
  counters.scansInfected += summary.infected ?? 0;
  counters.scansUnscannable += summary.unscannable ?? 0;
  counters.scanErrors += summary.errors ?? 0;
}

/** For tests: reset all accumulated state. */
export function resetWorkerMetrics(): void {
  counters.notificationsSent = 0;
  counters.notificationsFailed = 0;
  counters.scansClean = 0;
  counters.scansInfected = 0;
  counters.scansUnscannable = 0;
  counters.scanErrors = 0;
  webhookDeliveries.sent = 0;
  webhookDeliveries.failed = 0;
  webhookDeliveries.skipped = 0;
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
    { name: "innobox_attachment_scans_unscannable_total", help: "Attachments the scan sweep gave up on as unscannable", type: "counter", value: counters.scansUnscannable },
    { name: "innobox_attachment_scan_errors_total", help: "Attachment scan sweep transient errors", type: "counter", value: counters.scanErrors },
    ...(["sent", "failed", "skipped"] as const).map((outcome) => ({
      name: "innobox_webhook_deliveries_total",
      help: "Channel-webhook deliveries by final outcome",
      type: "counter" as const,
      value: webhookDeliveries[outcome],
      labels: { outcome },
    })),
  ];
}

// ── HTTP handlers (§2) ───────────────────────────────────────────────────────────────────

export interface MetricsEnv {
  METRICS_TOKEN?: string;
  NODE_ENV?: string;
}

/** GET /metrics: the shared constant-time bearer gate, then the worker samples. An unset
 *  METRICS_TOKEN leaves it open in dev but disables it (404) in a production build. */
export function createMetricsHandler(getEnv: () => MetricsEnv = () => process.env) {
  return (req: Request, res: Response): void => {
    const env = getEnv();
    const access = metricsAccess({
      authorization: req.header("authorization"),
      token: env.METRICS_TOKEN,
      nodeEnv: env.NODE_ENV,
    });
    if (access === "disabled") {
      res.status(404).type("text/plain").send("not found\n");
      return;
    }
    if (access === "unauthorized") {
      res.status(401).type("text/plain").send("unauthorized\n");
      return;
    }
    res.status(200).set("cache-control", "no-store").type("text/plain; version=0.0.4").send(renderMetrics(workerMetricsSamples()));
  };
}

/** GET /healthz: liveness — only the status word (no version or other detail). */
export function healthzHandler(_req: Request, res: Response): void {
  res.status(200).set("cache-control", "no-store").json({ status: "ok" });
}

/** The worker's readiness checks, in order; the first failing one is named in the response. */
export type ReadinessCheck = "database" | "leader";

/** GET /readyz: the database answers and this instance holds the leader lock. The body carries
 *  only the status word and the failing check's name; the exception detail goes to the
 *  structured log, never the response (unauthenticated probe). */
export function createReadyzHandler(deps: { pingDb: () => Promise<unknown>; isLeader: () => boolean }) {
  return async (_req: Request, res: Response): Promise<void> => {
    let failed: ReadinessCheck | null = null;
    try {
      await deps.pingDb();
      if (!deps.isLeader()) failed = "leader";
    } catch (err) {
      failed = "database";
      console.error(
        JSON.stringify({ level: "error", msg: "readiness check failed", check: "database", error: String(err) }),
      );
    }
    res.set("cache-control", "no-store");
    if (failed) {
      res.status(503).json({ status: "not_ready", check: failed });
      return;
    }
    res.status(200).json({ status: "ok" });
  };
}

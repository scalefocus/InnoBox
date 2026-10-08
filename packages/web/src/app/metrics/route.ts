// GET /metrics (INNOBOX_SPEC.md §2, observability): Prometheus text exposition for the web
// service. Bearer-token-guarded when METRICS_TOKEN is set (open in local dev when unset). Emits
// build/up/process gauges; the worker exposes the queue/sweep counters (its /metrics handler).
import { APP_VERSION } from "@innobox/shared/version";
import { renderMetrics, metricsAuthorized, type MetricSample } from "@innobox/shared";

export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  if (!metricsAuthorized(req.headers.get("authorization"), process.env.METRICS_TOKEN)) {
    return new Response("unauthorized\n", { status: 401 });
  }

  const mem = process.memoryUsage();
  const samples: MetricSample[] = [
    { name: "innobox_build_info", help: "Build/version info (always 1)", type: "gauge", value: 1, labels: { version: APP_VERSION, service: "web" } },
    { name: "innobox_up", help: "1 if the service is up", type: "gauge", value: 1, labels: { service: "web" } },
    { name: "innobox_process_resident_memory_bytes", help: "Resident set size in bytes", type: "gauge", value: mem.rss, labels: { service: "web" } },
    { name: "innobox_process_heap_used_bytes", help: "V8 heap used in bytes", type: "gauge", value: mem.heapUsed, labels: { service: "web" } },
    { name: "innobox_process_uptime_seconds", help: "Process uptime in seconds", type: "gauge", value: Math.round(process.uptime()), labels: { service: "web" } },
  ];

  return new Response(renderMetrics(samples), {
    status: 200,
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" },
  });
}

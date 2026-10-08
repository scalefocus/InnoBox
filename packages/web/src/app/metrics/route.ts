// GET /metrics (INNOBOX_SPEC.md §2, observability): Prometheus text exposition for the web
// service. Bearer-token-guarded (constant time) when METRICS_TOKEN is set; when it is unset the
// route is open in local dev but disabled (404) in a production build. Emits
// build/up/process gauges and innobox_csp_violations_total{directive} (§2.4, the CSP report sink);
// the worker exposes the queue/sweep counters (its /metrics handler).
import { APP_VERSION } from "@innobox/shared/version";
import { renderMetrics, metricsAccess, type MetricSample } from "@innobox/shared";
import { cspViolationCounts } from "@/lib/csp-report";

export const dynamic = "force-dynamic";

export function GET(req: Request): Response {
  const access = metricsAccess({
    authorization: req.headers.get("authorization"),
    token: process.env.METRICS_TOKEN,
    nodeEnv: process.env.NODE_ENV,
  });
  if (access === "disabled") return new Response("not found\n", { status: 404 });
  if (access === "unauthorized") return new Response("unauthorized\n", { status: 401 });

  const mem = process.memoryUsage();
  const samples: MetricSample[] = [
    { name: "innobox_build_info", help: "Build/version info (always 1)", type: "gauge", value: 1, labels: { version: APP_VERSION, service: "web" } },
    { name: "innobox_up", help: "1 if the service is up", type: "gauge", value: 1, labels: { service: "web" } },
    { name: "innobox_process_resident_memory_bytes", help: "Resident set size in bytes", type: "gauge", value: mem.rss, labels: { service: "web" } },
    { name: "innobox_process_heap_used_bytes", help: "V8 heap used in bytes", type: "gauge", value: mem.heapUsed, labels: { service: "web" } },
    { name: "innobox_process_uptime_seconds", help: "Process uptime in seconds", type: "gauge", value: Math.round(process.uptime()), labels: { service: "web" } },
  ];
  // §2.4 CSP report sink: one series per allowlisted directive seen since the process started.
  for (const { directive, count } of cspViolationCounts()) {
    samples.push({ name: "innobox_csp_violations_total", help: "CSP violations reported to /api/csp-report, by effective directive", type: "counter", value: count, labels: { directive } });
  }

  return new Response(renderMetrics(samples), {
    status: 200,
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" },
  });
}

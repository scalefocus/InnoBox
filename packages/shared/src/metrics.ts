// Minimal Prometheus text-exposition helpers (INNOBOX_SPEC.md §2, observability). The format is
// trivial, so we hand-roll it rather than pull in a dependency — this stays client-safe (pure, no
// `process`/node APIs; each service composes its own samples, including process gauges) and is
// fully unit-testable. Web (/metrics route) and worker (/metrics express handler) both use it.

export type MetricType = "gauge" | "counter";

export interface MetricSample {
  /** Metric name, e.g. `innobox_up`. Samples sharing a name share one HELP/TYPE header. */
  name: string;
  help: string;
  type: MetricType;
  value: number;
  labels?: Record<string, string>;
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatLabels(labels?: Record<string, string>): string {
  if (!labels) return "";
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${escapeLabelValue(String(v))}"`).join(",")}}`;
}

/** Render samples to the Prometheus text exposition format. Samples with the same `name` are
 *  grouped under a single `# HELP` / `# TYPE` header (as the format requires). */
export function renderMetrics(samples: MetricSample[]): string {
  const order: string[] = [];
  const byName = new Map<string, MetricSample[]>();
  for (const s of samples) {
    let group = byName.get(s.name);
    if (!group) {
      group = [];
      byName.set(s.name, group);
      order.push(s.name);
    }
    group.push(s);
  }
  const lines: string[] = [];
  for (const name of order) {
    const group = byName.get(name)!;
    lines.push(`# HELP ${name} ${group[0]!.help}`);
    lines.push(`# TYPE ${name} ${group[0]!.type}`);
    for (const s of group) lines.push(`${name}${formatLabels(s.labels)} ${s.value}`);
  }
  return lines.join("\n") + "\n";
}

/** §2 observability: `/metrics` requires the bearer token when `METRICS_TOKEN` is set (401
 *  otherwise); when the token is unset the endpoint is open (local dev convenience). */
export function metricsAuthorized(authorizationHeader: string | null | undefined, token: string | undefined | null): boolean {
  if (!token) return true; // unset → open (dev)
  return authorizationHeader === `Bearer ${token}`;
}

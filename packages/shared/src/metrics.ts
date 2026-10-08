// Minimal Prometheus text-exposition helpers (INNOBOX_SPEC.md §2, observability). The format is
// trivial, so we hand-roll it rather than pull in a dependency. Pure (no `process` reads — each
// service composes its own samples, including process gauges, and passes its env in) and fully
// unit-testable. Server-only: the token gate uses node:crypto, and this module is reached only
// through the server-side root barrel. Web (/metrics route) and worker (/metrics express handler)
// both use it.
import { createHash, timingSafeEqual } from "node:crypto";

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

/** The outcome of the §2 `/metrics` gate: serve the samples, answer 401, or answer 404. */
export type MetricsAccess = "allow" | "unauthorized" | "disabled";

/** Constant-time string equality. Both sides are hashed to fixed-length SHA-256 digests first,
 *  so neither the comparison time nor an early length mismatch reveals how long the secret is. */
function constantTimeEqual(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** §2 observability: the `/metrics` gate shared by web and worker.
 *  - `METRICS_TOKEN` set → the request must carry exactly `Authorization: Bearer <token>`,
 *    compared in constant time (`unauthorized` → 401 otherwise).
 *  - unset outside production → open (local dev convenience).
 *  - unset in a production build (`NODE_ENV=production`) → `disabled` (404), so a forgotten
 *    variable can never publish process details through the public proxy. */
export function metricsAccess(opts: {
  authorization: string | null | undefined;
  token: string | null | undefined;
  nodeEnv: string | null | undefined;
}): MetricsAccess {
  if (!opts.token) return opts.nodeEnv === "production" ? "disabled" : "allow";
  return constantTimeEqual(opts.authorization ?? "", `Bearer ${opts.token}`) ? "allow" : "unauthorized";
}

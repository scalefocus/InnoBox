// §25.11 agent-access metrics for the web /metrics route (INNOBOX_SPEC.md §2): in-process counters,
// reset on restart like every other web-tier counter. Labels come from fixed sets only — the tool
// label is a registered tool name or "unknown", so a caller can never mint new series.
import type { MetricSample } from "@innobox/shared";

export type ToolOutcome = "ok" | "error" | "forbidden" | "not_found" | "conflict" | "invalid" | "rate_limited";
export type TokenEvent = "issued" | "refreshed" | "revoked" | "reuse";

const toolCalls = new Map<string, number>();
const tokenEvents = new Map<TokenEvent, number>();
let registrations = 0;

export function countToolCall(tool: string, outcome: ToolOutcome): void {
  const key = `${tool}\u0000${outcome}`;
  toolCalls.set(key, (toolCalls.get(key) ?? 0) + 1);
}

export function countTokenEvent(event: TokenEvent): void {
  tokenEvents.set(event, (tokenEvents.get(event) ?? 0) + 1);
}

export function countRegistration(): void {
  registrations++;
}

export function mcpMetricSamples(): MetricSample[] {
  const samples: MetricSample[] = [];
  for (const [key, value] of toolCalls) {
    const [tool, outcome] = key.split("\u0000") as [string, string];
    samples.push({ name: "innobox_mcp_tool_calls_total", help: "MCP tool calls by tool and outcome", type: "counter", value, labels: { tool, outcome } });
  }
  for (const [event, value] of tokenEvents) {
    samples.push({ name: "innobox_mcp_tokens_total", help: "OAuth token events for agent access", type: "counter", value, labels: { event } });
  }
  samples.push({ name: "innobox_mcp_registrations_total", help: "OAuth dynamic client registrations", type: "counter", value: registrations });
  return samples;
}

/** For tests. */
export function resetMcpMetrics(): void {
  toolCalls.clear();
  tokenEvents.clear();
  registrations = 0;
}

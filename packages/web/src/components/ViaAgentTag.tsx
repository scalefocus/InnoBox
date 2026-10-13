// The "via agent" attribution tag (INNOBOX_SPEC.md §25.8): a small muted inline tag beside the
// author line of a challenge, solution or comment created through the MCP server (§25), and in
// the §14.1 triage queue row. The API already masks it — `{ client: null }` for an anonymous item
// (a registered client name could point to one person), so the tag shows plain "via agent" — and
// sends `null` for anything created in the browser, which renders nothing. Not used on list cards,
// search results or e-mails.

import type { ViaAgent } from "@innobox/shared/mcp";

/** The payload shape every detail, comment and triage row carries (absent = created in the browser). */
export type { ViaAgent };

export const VIA_AGENT_TOOLTIP = "Submitted through an AI agent its author connected.";

/** The tag's visible text: "via agent", plus " · <client name>" when the API sent one. */
export function viaAgentLabel(via: { client: string | null }): string {
  const client = via.client?.trim();
  return client ? `via agent · ${client}` : "via agent";
}

/** `flush` drops the leading margin where the parent is a flex row that already has a gap. */
export function ViaAgentTag({ via, flush = false }: { via: ViaAgent | undefined; flush?: boolean }) {
  if (!via) return null;
  return (
    <span className={flush ? "via-agent-tag is-flush" : "via-agent-tag"} title={VIA_AGENT_TOOLTIP} data-testid="via-agent-tag">
      {viaAgentLabel(via)}
    </span>
  );
}

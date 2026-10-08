"use client";
// "Verify integrity" on the audit browser (INNOBOX_SPEC.md §15): runs POST /api/admin/audit/verify
// and reads its NDJSON stream — "Checked n of N rows…" while it runs, then the intact/broken
// verdict. Leaving the page abandons the run (the server stops and audits it as aborted).
import { useEffect, useRef, useState } from "react";

interface ChainBreak {
  id: string | null;
  chainSeq: number | null;
  check: "genesis" | "sequence" | "link" | "content" | "unchained";
  expected: string | number | null;
  actual: string | number | null;
}

type VerifyState =
  | { phase: "idle" }
  | { phase: "running"; checked: number; head: number | null }
  | { phase: "intact"; checked: number; headSeq: number }
  | { phase: "broken"; checked: number; brk: ChainBreak | null }
  | { phase: "error"; message: string };

type StreamLine =
  | { type: "start"; head: number }
  | { type: "progress"; checked: number }
  | { type: "result"; result: "intact" | "broken"; checked: number; head: { chainSeq: number; rowHash: string } | null; firstBreak: ChainBreak | null }
  | { type: "error"; error: string };

const CHECK_LABEL: Record<ChainBreak["check"], string> = {
  genesis: "chain start",
  sequence: "sequence",
  link: "link",
  content: "content",
  unchained: "pre-chain entries",
};

function shortValue(v: string | number | null): string {
  if (v === null) return "nothing";
  const s = String(v);
  return /^[0-9a-f]{64}$/.test(s) ? `${s.slice(0, 12)}…` : s;
}

function brokenMessage(brk: ChainBreak | null): string {
  if (!brk) return "Audit log broken.";
  const detail = `expected ${shortValue(brk.expected)}, found ${shortValue(brk.actual)}`;
  if (brk.id) return `Audit log broken at entry #${brk.id}: ${detail}`;
  return `Audit log broken (${CHECK_LABEL[brk.check]} check): ${detail}`;
}

export function VerifyIntegrity() {
  const [state, setState] = useState<VerifyState>({ phase: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  // Leaving the page abandons a running verification.
  useEffect(() => () => abortRef.current?.abort(), []);

  const run = async () => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ phase: "running", checked: 0, head: null });
    let final: VerifyState | null = null;
    try {
      const res = await fetch("/api/admin/audit/verify", { method: "POST", headers: { accept: "application/x-ndjson" }, signal: ctrl.signal });
      if (!res.ok || !res.body) {
        let message = `Verification failed (${res.status}).`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j.error) message = j.error;
        } catch {
          /* not JSON */
        }
        setState({ phase: "error", message });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let head: number | null = null;
      const handle = (line: StreamLine) => {
        if (line.type === "start") {
          head = line.head;
          setState({ phase: "running", checked: 0, head });
        } else if (line.type === "progress") {
          setState({ phase: "running", checked: line.checked, head });
        } else if (line.type === "result") {
          final =
            line.result === "intact"
              ? { phase: "intact", checked: line.checked, headSeq: line.head?.chainSeq ?? 0 }
              : { phase: "broken", checked: line.checked, brk: line.firstBreak };
        } else if (line.type === "error") {
          final = { phase: "error", message: line.error };
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const text = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (text) handle(JSON.parse(text) as StreamLine);
          nl = buf.indexOf("\n");
        }
        if (done) break;
      }
      setState(final ?? { phase: "error", message: "The verification ended without a result." });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setState({ phase: "error", message: err instanceof Error ? err.message : "Verification failed." });
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  };

  const running = state.phase === "running";
  return (
    <div className="card card-pad reveal audit-verify" style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div className="grow" style={{ minWidth: 220 }}>
          <strong>Integrity</strong>
          <p className="sub" style={{ margin: "2px 0 0" }}>
            Recompute the hash chain and confirm no entry was edited, removed or slipped in.
          </p>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => void run()} disabled={running}>
          {running ? "Verifying…" : "Verify integrity"}
        </button>
      </div>
      {state.phase !== "idle" && (
        <p
          className={`sub audit-verify-status audit-verify-${state.phase}`}
          role="status"
          aria-live="polite"
          style={{ marginTop: 10, marginBottom: 0 }}
        >
          {state.phase === "running" &&
            (state.head === null
              ? "Starting…"
              : `Checked ${state.checked.toLocaleString()} of ${state.head.toLocaleString()} rows…`)}
          {state.phase === "intact" &&
            `Audit log intact — ${state.checked.toLocaleString()} entries verified (chain head #${state.headSeq})`}
          {state.phase === "broken" && brokenMessage(state.brk)}
          {state.phase === "error" && state.message}
        </p>
      )}
    </div>
  );
}

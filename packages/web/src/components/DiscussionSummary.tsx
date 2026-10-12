"use client";
// The §22.13 "Summarize discussion" control above a comment thread (INNOBOX_SPEC.md): shown once
// the thread holds at least 10 visible comments and summaries are available for this item. The
// summary is plain text (React escapes it), headed "Summary by {name}" with when it was made and
// "May be inaccurate."; new or edited comments mark it stale, with Refresh.
import { useCallback, useEffect, useState } from "react";
import { readJson } from "@/lib/api-client";
import { useDateFmt } from "@/components/DateFormat";

interface SummaryView {
  available: boolean;
  eligible: boolean;
  commentCount: number;
  displayName: string;
  summary: { summary: string; openQuestions: string[]; createdAt: string; stale: boolean } | null;
}

/** `version` changes whenever the thread changes (a post, an edit, a delete) so the control
 *  re-reads whether it shows and whether the summary is stale. */
export function DiscussionSummary({ parentType, parentNumber, version }: { parentType: "challenge" | "solution"; parentNumber: string; version: string }) {
  const fmt = useDateFmt();
  const digits = parentNumber.replace(/^(CH|SOL)-/, "");
  const url = `/api/ai/summary/${parentType}/${digits}`;
  const [view, setView] = useState<SummaryView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      setView(res.ok ? ((await res.json()) as SummaryView) : null);
    } catch {
      setView(null);
    }
  }, [url]);

  useEffect(() => {
    void load();
  }, [load, version]);

  if (!view) return null;
  // A summary made earlier stays readable; the control itself needs availability and a long thread.
  const canAsk = view.available && view.eligible;
  if (!canAsk && !view.summary) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { method: "POST" });
      const json = await readJson(res);
      if (!res.ok || json.ok !== true) throw new Error(json.error ?? "Couldn't summarize the discussion right now — try again later.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't summarize the discussion right now — try again later.");
    } finally {
      setBusy(false);
    }
  };

  const s = view.summary;
  return (
    <div className="card card-pad ai-summary" data-testid="discussion-summary" style={{ marginBottom: 14 }}>
      {s ? (
        <>
          <div className="ai-panel-head">
            <span className="ai-panel-title">✨ Summary by {view.displayName}</span>
            <span className="sub mono">{fmt.dateTime(s.createdAt)}</span>
          </div>
          <p className="muted" style={{ fontSize: 12.5, margin: "2px 0 10px" }}>
            May be inaccurate.
          </p>
          <p style={{ whiteSpace: "pre-wrap", fontSize: 14, margin: 0 }}>{s.summary}</p>
          {s.openQuestions.length > 0 && (
            <div className="ai-notes">
              <h4>Open questions</h4>
              <ul>
                {s.openQuestions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          {s.stale && canAsk && (
            <p className="sub" style={{ margin: "10px 0 0", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              New comments since this summary.
              <button type="button" className="btn btn-sm" disabled={busy} onClick={run}>
                {busy ? "Summarizing…" : "Refresh"}
              </button>
            </p>
          )}
        </>
      ) : (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={run}>
          {busy ? (
            <>
              <span className="spinner" aria-hidden="true" /> Summarizing…
            </>
          ) : (
            `✨ Summarize discussion (${view.commentCount} comments)`
          )}
        </button>
      )}
      {error && (
        <p className="muted" role="alert" style={{ color: "var(--danger)", fontSize: 13, margin: "8px 0 0" }}>
          {error}
        </p>
      )}
    </div>
  );
}

"use client";
// The §22.11 "{name} triage notes" panel on a challenge's detail page (INNOBOX_SPEC.md): an
// advisory note for its namespace's admins, and — once past awaiting_triage — its committee and
// assignee; never its author. The server decides who sees it (404 = render nothing). Collapsible,
// plain text only (React escapes it), "Pending" until the worker's note lands (polled), and
// Re-run for namespace and platform admins. It never changes anything about the challenge.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { readJson } from "@/lib/api-client";
import { useDateFmt } from "@/components/DateFormat";

interface TriageView {
  effective: boolean;
  state: "none" | "pending" | "ready" | "failed";
  current: boolean;
  restrictedBlocked: boolean;
  canRerun: boolean;
  generatedAt: string | null;
  displayName: string;
  notes: {
    summary: string;
    missingInformation: string[];
    suggestedImpactArea: string | null;
    /** §34.6: active topics only — advisory; an admin applies one through Edit topics. */
    suggestedTopics?: string[];
    questions: string[];
    duplicates: { number: string; title: string; reason: string }[];
  } | null;
}

const POLL_MS = 10_000;
const MAX_POLLS = 60;

/** `version` changes whenever the challenge is re-read (status, edits) so the panel refetches. */
export function TriageNotesPanel({ challengeNumber, version }: { challengeNumber: string; version: string }) {
  const fmt = useDateFmt();
  const digits = challengeNumber.replace("CH-", "");
  const [view, setView] = useState<TriageView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [polls, setPolls] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/ai/triage/${digits}`, { headers: { accept: "application/json" } });
      if (!res.ok) {
        setView(null);
        return;
      }
      setView((await res.json()) as TriageView);
    } catch {
      /* advisory — a failed read just shows nothing */
    }
  }, [digits]);

  useEffect(() => {
    void load();
  }, [load, version]);

  // While a note is on its way, look again every few seconds (bounded).
  useEffect(() => {
    if (view?.state !== "pending" || polls >= MAX_POLLS) return;
    const t = window.setTimeout(() => {
      setPolls((p) => p + 1);
      void load();
    }, POLL_MS);
    return () => window.clearTimeout(t);
  }, [view, polls, load]);

  if (!view) return null;

  const rerun = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/ai/triage/${digits}/rerun`, { method: "POST" });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not re-run the triage notes");
      setPolls(0);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not re-run the triage notes");
    } finally {
      setBusy(false);
    }
  };

  const n = view.notes;
  return (
    <details className="card card-pad reveal ai-panel" open data-testid="triage-notes" style={{ marginBottom: 18 }}>
      <summary className="ai-panel-head">
        <span className="ai-panel-title">✨ {view.displayName} triage notes</span>
        {view.state === "pending" && <span className="pill pill-muted">Pending</span>}
        {view.state === "failed" && <span className="pill pill-warn">Couldn&apos;t prepare notes</span>}
        {view.state === "ready" && !view.current && <span className="pill pill-muted">From an earlier version</span>}
      </summary>

      <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 12px" }}>
        Advisory notes for reviewers. They may be inaccurate and never change anything on their own; the author doesn&apos;t see them.
      </p>

      {view.restrictedBlocked && !n && (
        <p className="muted" style={{ fontSize: 13 }}>Not prepared for challenges visible only to their namespace.</p>
      )}
      {view.state === "pending" && !n && <p className="muted" style={{ fontSize: 13 }}>Preparing notes…</p>}
      {view.state === "none" && !n && !view.restrictedBlocked && (
        <p className="muted" style={{ fontSize: 13 }}>No notes for this challenge.</p>
      )}

      {n && (
        <div className="ai-notes">
          <p style={{ margin: "0 0 10px", fontSize: 14 }}>{n.summary}</p>
          {n.missingInformation.length > 0 && (
            <>
              <h4>Missing information</h4>
              <ul>
                {n.missingInformation.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </>
          )}
          {n.suggestedImpactArea && (
            <p style={{ fontSize: 13 }}>
              <strong>Suggested impact area:</strong> {n.suggestedImpactArea}
            </p>
          )}
          {n.suggestedTopics && n.suggestedTopics.length > 0 && (
            <p style={{ fontSize: 13 }}>
              <strong>Suggested topics:</strong> {n.suggestedTopics.join(", ")}
            </p>
          )}
          {n.questions.length > 0 && (
            <>
              <h4>Questions to ask the author</h4>
              <ul>
                {n.questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </>
          )}
          {n.duplicates.length > 0 && (
            <>
              <h4>Possible duplicates</h4>
              <ul>
                {n.duplicates.map((d) => (
                  <li key={d.number}>
                    <Link href={`/challenges/${d.number.replace("CH-", "")}`}>
                      <span className="mono">{d.number}</span> {d.title}
                    </Link>
                    {d.reason && <span className="sub"> — {d.reason}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {view.generatedAt && (
            <p className="sub mono" style={{ margin: "10px 0 0" }}>
              Prepared {fmt.dateTime(view.generatedAt)}
            </p>
          )}
        </div>
      )}

      {view.canRerun && (
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={rerun}>
            Re-run
          </button>
        </div>
      )}
      {error && (
        <p className="muted" role="alert" style={{ color: "var(--danger)", fontSize: 13 }}>
          {error}
        </p>
      )}
    </details>
  );
}

"use client";
// Leaderboard (INNOBOX_SPEC.md §13.3): top 10 across four metrics, two windows (last 30
// days / all time). Computed over org-visible, non-anonymous, non-rejected contributions —
// the API already applies that filter, so this page only renders the ranked entries.
import Link from "next/link";
import { useEffect, useState } from "react";
import { AvatarBubble } from "@/components/AvatarBubble";

interface LeaderboardEntry {
  userId: string;
  displayName: string;
  count: number;
}

const METRICS: { key: string; label: string }[] = [
  { key: "solutions_implemented", label: "Solutions implemented" },
  { key: "challenges_submitted", label: "Challenges submitted" },
  { key: "solutions_proposed", label: "Solutions proposed" },
  { key: "likes_received", label: "Likes received" },
];

const WINDOWS: { key: string; label: string }[] = [
  { key: "30d", label: "Last 30 days" },
  { key: "all", label: "All time" },
];

export default function LeaderboardPage() {
  const [metric, setMetric] = useState("solutions_implemented");
  const [window_, setWindow] = useState("all");
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);

  useEffect(() => {
    setEntries(null);
    fetch(`/api/leaderboards?metric=${metric}&window=${window_}`, { headers: { accept: "application/json" } })
      .then((res) => res.json())
      .then((json) => setEntries(json.entries ?? []))
      .catch(() => setEntries([]));
  }, [metric, window_]);

  return (
    <>
      <div className="page-head reveal">
        <div className="eyebrow">Rankings</div>
        <h1 className="page-title">Leaderboard</h1>
        <p className="page-sub">
          Top contributors across the org — non-anonymous, org-visible work only. Anonymous
          contributions count only after the author reveals themselves.
        </p>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        {METRICS.map((m) => (
          <button
            key={m.key}
            type="button"
            className={metric === m.key ? "btn btn-sm btn-primary" : "btn btn-sm"}
            onClick={() => setMetric(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
        {WINDOWS.map((w) => (
          <button
            key={w.key}
            type="button"
            className={window_ === w.key ? "btn btn-sm btn-primary" : "btn btn-sm"}
            onClick={() => setWindow(w.key)}
          >
            {w.label}
          </button>
        ))}
      </div>

      {entries === null && <p className="muted">Loading…</p>}
      {entries !== null && entries.length === 0 && (
        <div className="card card-pad empty reveal">
          <div className="ico">🏆</div>
          <p className="muted" style={{ margin: 0 }}>
            No qualifying contributions in this window yet.
          </p>
        </div>
      )}
      {entries !== null && entries.length > 0 && (
        <div className="rows">
          {entries.map((entry, i) => (
            <div className="row" key={entry.userId}>
              <span className="chip mono" style={{ minWidth: 32, textAlign: "center" }}>
                {i + 1}
              </span>
              <AvatarBubble size="sm" userId={entry.userId} displayName={entry.displayName} />
              <Link href={`/profile/${entry.userId}`} className="ttl grow">
                {entry.displayName}
              </Link>
              <span className="pill pill-accent mono">{entry.count}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

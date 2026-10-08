"use client";
// Search results (INNOBOX_SPEC.md §13.4): full-text search over challenges/solutions plus
// exact CH-<n>/SOL-<n> lookup. Results are already visibility-filtered and anonymity-masked
// server-side — this page only renders what the API returned.
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { CHALLENGE_STATUS_LABEL, SOLUTION_STATUS_LABEL, statusPillClass } from "../challenges/status";
import { AvatarBubble } from "@/components/AvatarBubble";
import { itemHref } from "@/lib/deep-link";

interface ChallengeResult {
  number: string;
  title: string;
  author: { userId: string | null; displayName: string; anonymous: boolean };
  status: string;
  namespaceSlug: string;
}

interface SolutionResult {
  number: string;
  description: string;
  author: { userId: string | null; displayName: string; anonymous: boolean };
  status: string;
  challengeNumber: string;
  challengeTitle: string;
}

export default function SearchPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <SearchPageInner />
    </Suspense>
  );
}

function SearchPageInner() {
  const params = useSearchParams();
  const initialQ = params.get("q") ?? "";
  const [query, setQuery] = useState(initialQ);
  const [submitted, setSubmitted] = useState(initialQ);
  const [challenges, setChallenges] = useState<ChallengeResult[] | null>(null);
  const [solutions, setSolutions] = useState<SolutionResult[] | null>(null);

  useEffect(() => {
    if (submitted.trim() === "") {
      setChallenges([]);
      setSolutions([]);
      return;
    }
    setChallenges(null);
    setSolutions(null);
    fetch(`/api/search?q=${encodeURIComponent(submitted)}`, { headers: { accept: "application/json" } })
      .then((res) => res.json())
      .then((json) => {
        setChallenges(json.challenges ?? []);
        setSolutions(json.solutions ?? []);
      })
      .catch(() => {
        setChallenges([]);
        setSolutions([]);
      });
  }, [submitted]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(query);
  };

  return (
    <>
      <div className="page-head reveal">
        <div className="eyebrow">Search</div>
        <h1 className="page-title">Find a challenge or solution</h1>
        <p className="page-sub">Search titles and descriptions, or jump straight to CH-123 / SOL-456.</p>
      </div>

      <form onSubmit={onSubmit} style={{ display: "flex", gap: 8, marginBottom: 22 }}>
        <input
          autoFocus
          style={{
            flex: 1,
            padding: "10px 14px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--line-strong)",
            background: "var(--surface)",
            color: "var(--ink)",
            fontFamily: "var(--font-body)",
            fontSize: 15,
          }}
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>

      {submitted.trim() === "" && <p className="muted">Type something to search.</p>}

      {submitted.trim() !== "" && (
        <>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 19, margin: "0 0 12px" }}>
            Challenges {challenges && `(${challenges.length})`}
          </h2>
          {challenges === null && <p className="muted">Searching…</p>}
          {challenges !== null && challenges.length === 0 && <p className="muted">No matching challenges.</p>}
          {challenges !== null && challenges.length > 0 && (
            <div className="rows" style={{ marginBottom: 26 }}>
              {challenges.map((c) => (
                <Link key={c.number} href={itemHref(c.number)} className="row">
                  <span className="chip mono">{c.number}</span>
                  <span className={statusPillClass(c.status)}>{CHALLENGE_STATUS_LABEL[c.status] ?? c.status}</span>
                  <span className="ttl grow">{c.title}</span>
                  <AvatarBubble size="sm" userId={c.author.userId} displayName={c.author.displayName} anonymous={c.author.anonymous} />
                  <span className="sub">{c.author.anonymous ? "Anonymous" : c.author.displayName}</span>
                </Link>
              ))}
            </div>
          )}

          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 19, margin: "0 0 12px" }}>
            Solutions {solutions && `(${solutions.length})`}
          </h2>
          {solutions === null && <p className="muted">Searching…</p>}
          {solutions !== null && solutions.length === 0 && <p className="muted">No matching solutions.</p>}
          {solutions !== null && solutions.length > 0 && (
            <div className="rows">
              {solutions.map((s) => (
                <Link key={s.number} href={itemHref(s.challengeNumber, s.number)} className="row">
                  <span className="chip mono">{s.number}</span>
                  <span className={statusPillClass(s.status)}>{SOLUTION_STATUS_LABEL[s.status] ?? s.status}</span>
                  <span className="ttl grow">{s.description}</span>
                  <AvatarBubble size="sm" userId={s.author.userId} displayName={s.author.displayName} anonymous={s.author.anonymous} />
                  <span className="sub">{s.author.anonymous ? "Anonymous" : s.author.displayName}</span>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

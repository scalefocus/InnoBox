"use client";
// Challenges gallery (INNOBOX_SPEC.md §13.1): tabs (Open/Mine/Completed), filters
// (status/impact area/namespace/author), sort (newest/most liked/most solutions), cards.
// Strictly visibility-filtered and anonymity-masked server-side — this page only renders
// what the API already decided the viewer may see.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { cachedGet } from "@/lib/ui";
import { useDateFmt } from "@/components/DateFormat";
import { AvatarBubble } from "@/components/AvatarBubble";
import { CHALLENGE_STATUS_LABEL, statusPillClass } from "./status";

interface ChallengeListItem {
  id: string;
  number: string;
  title: string;
  author: { userId: string | null; displayName: string; anonymous: boolean };
  namespaceSlug: string;
  impactAreaName: string;
  status: string;
  createdAt: string;
  likeCount: number;
  likedByViewer: boolean;
  solutionCount: number;
}

interface ImpactArea {
  id: string;
  name: string;
  active: boolean;
}

interface NamespaceOption {
  id: string;
  slug: string;
  displayName: string;
}

type Tab = "open" | "mine" | "completed";
type Sort = "newest" | "most_liked" | "most_solutions";

const TABS: { key: Tab; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "mine", label: "Mine" },
  { key: "completed", label: "Completed" },
];

const SORTS: { key: Sort; label: string }[] = [
  { key: "newest", label: "Newest" },
  { key: "most_liked", label: "Most liked" },
  { key: "most_solutions", label: "Most solutions" },
];

export default function ChallengesPage() {
  const [tab, setTab] = useState<Tab>("open");
  const [sort, setSort] = useState<Sort>("newest");
  const [status, setStatus] = useState("");
  const [impactAreaId, setImpactAreaId] = useState("");
  const [namespaceId, setNamespaceId] = useState("");
  const [authorName, setAuthorName] = useState("");

  const [challenges, setChallenges] = useState<ChallengeListItem[] | null>(null);
  const [impactAreas, setImpactAreas] = useState<ImpactArea[]>([]);
  const [namespaces, setNamespaces] = useState<NamespaceOption[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cachedGet<{ impactAreas: ImpactArea[] }>("/api/impact-areas")
      .then((j) => setImpactAreas(j.impactAreas))
      .catch(() => {});
    cachedGet<{ namespaces: NamespaceOption[] }>("/api/namespaces")
      .then((j) => setNamespaces(j.namespaces))
      .catch(() => {});
  }, []);

  const queryString = useMemo(() => {
    const params = new URLSearchParams({ tab, sort });
    if (status) params.set("status", status);
    if (impactAreaId) params.set("impactAreaId", impactAreaId);
    if (namespaceId) params.set("namespaceId", namespaceId);
    if (authorName.trim()) params.set("authorName", authorName.trim());
    return params.toString();
  }, [tab, sort, status, impactAreaId, namespaceId, authorName]);

  useEffect(() => {
    let live = true;
    setChallenges(null);
    setError(null);
    fetch(`/api/challenges?${queryString}`, { headers: { accept: "application/json" } })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Could not load challenges");
        if (live) setChallenges(json.challenges);
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : "Could not load challenges");
      });
    return () => {
      live = false;
    };
  }, [queryString]);

  const statusOptions = Object.keys(CHALLENGE_STATUS_LABEL);

  return (
    <>
      <div className="page-head reveal" style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div className="eyebrow">Challenges</div>
          <h1 className="page-title">Ideas worth building</h1>
          <p className="page-sub">Browse challenges you can see, or propose a solution to one that&apos;s open.</p>
        </div>
        <Link href="/challenges/new" className="btn btn-primary">
          New challenge
        </Link>
      </div>

      <div className="srctabs" style={{ marginBottom: 18 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={tab === t.key ? "srctab active" : "srctab"}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 22 }}>
        <select className="field" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {statusOptions.map((s) => (
            <option key={s} value={s}>
              {CHALLENGE_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select className="field" value={impactAreaId} onChange={(e) => setImpactAreaId(e.target.value)}>
          <option value="">All impact areas</option>
          {impactAreas.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select className="field" value={namespaceId} onChange={(e) => setNamespaceId(e.target.value)}>
          <option value="">All my namespaces</option>
          {namespaces.map((ns) => (
            <option key={ns.id} value={ns.id}>
              {ns.displayName}
            </option>
          ))}
        </select>
        <input
          className="field"
          placeholder="Filter by author name"
          value={authorName}
          onChange={(e) => setAuthorName(e.target.value)}
        />
        <div className="sort-toggle">
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={sort === s.key ? "sort-opt sort-on" : "sort-opt"}
              onClick={() => setSort(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="card card-pad empty reveal">
          <div className="ico">⚠️</div>
          <p className="muted" style={{ margin: 0 }}>
            {error}
          </p>
        </div>
      )}

      {!error && challenges === null && <p className="muted">Loading challenges…</p>}

      {!error && challenges !== null && challenges.length === 0 && (
        <div className="card card-pad empty reveal">
          <div className="ico">🔍</div>
          <p className="muted" style={{ margin: 0 }}>
            No challenges match these filters yet.
          </p>
        </div>
      )}

      {!error && challenges !== null && challenges.length > 0 && (
        <div className="card-grid">
          {challenges.map((c) => (
            <ChallengeCard key={c.id} challenge={c} />
          ))}
        </div>
      )}
    </>
  );
}

function ChallengeCard({ challenge }: { challenge: ChallengeListItem }) {
  const fmt = useDateFmt();
  return (
    <Link href={`/challenges/${challenge.number.replace("CH-", "")}`} className="card skill-card">
      <div className="meta">
        <span className="chip mono">{challenge.number}</span>
        <span className={statusPillClass(challenge.status)}>{CHALLENGE_STATUS_LABEL[challenge.status] ?? challenge.status}</span>
        <span className="chip">{challenge.impactAreaName}</span>
      </div>
      <h3>{challenge.title}</h3>
      <div className="desc" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <AvatarBubble size="sm" userId={challenge.author.userId} displayName={challenge.author.displayName} anonymous={challenge.author.anonymous} />
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span>{challenge.author.anonymous ? "Anonymous" : challenge.author.displayName}</span>
          <span className="mono" style={{ fontSize: 11.5, color: "var(--faint)" }}>
            {fmt.date(challenge.createdAt)} · /{challenge.namespaceSlug}
          </span>
        </div>
      </div>
      <div className="meta">
        <span className="chip">❤ {challenge.likeCount}</span>
        <span className="chip">{challenge.solutionCount} solution{challenge.solutionCount === 1 ? "" : "s"}</span>
      </div>
    </Link>
  );
}

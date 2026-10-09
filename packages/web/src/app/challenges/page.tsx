"use client";
// Challenges gallery (INNOBOX_SPEC.md §13.1): tabs (Open/Mine/Completed), filters
// (status/impact area/namespace/author), sort (newest/most liked/most solutions), cards.
// Strictly visibility-filtered and anonymity-masked server-side — this page only renders
// what the API already decided the viewer may see.
import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useDateFmt } from "@/components/DateFormat";
import { AvatarBubble } from "@/components/AvatarBubble";
import { CHALLENGE_STATUS_LABEL, statusPillClass } from "./status";
import { readChallengesView, writeChallengesView, type ChallengesView } from "@/lib/challenges-view";
import { ChallengesList, ChallengesViewToggle } from "./ChallengesList";
import { ChallengeAuthorName, ChallengeNewTag, ChallengeStateBadges } from "./ChallengeBadges";
import { applyGalleryFilters, EMPTY_GALLERY_FILTERS, GalleryFilterFields, type GalleryFilterValues } from "./GalleryFilters";

interface ChallengeListItem {
  id: string;
  number: string;
  title: string;
  author: { userId: string | null; displayName: string; anonymous: boolean; active?: boolean };
  namespaceSlug: string;
  impactAreaName: string;
  status: string;
  createdAt: string;
  likeCount: number;
  likedByViewer: boolean;
  solutionCount: number;
  isNew: boolean;
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
  const [filters, setFilters] = useState<GalleryFilterValues>(EMPTY_GALLERY_FILTERS);

  const [challenges, setChallenges] = useState<ChallengeListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // §13.1 Cards / List toggle: persisted per browser (localStorage), read after mount — the server
  // snapshot is Cards and results only render once the post-mount fetch lands, so no hydration
  // mismatch and no flash. A click overrides it for the visit even when storage is blocked.
  const storedView = useSyncExternalStore(noSubscribe, () => readChallengesView(), () => "cards" as const);
  const [chosenView, setChosenView] = useState<ChallengesView | null>(null);
  const view = chosenView ?? storedView;
  const chooseView = (v: ChallengesView) => {
    setChosenView(v);
    writeChallengesView(v);
  };

  const queryString = useMemo(() => applyGalleryFilters(new URLSearchParams({ tab, sort }), filters).toString(), [tab, sort, filters]);

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
        <GalleryFilterFields value={filters} onChange={setFilters} />
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
        <ChallengesViewToggle view={view} onChange={chooseView} />
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

      {!error && challenges !== null && challenges.length > 0 && view === "list" && <ChallengesList challenges={challenges} />}

      {!error && challenges !== null && challenges.length > 0 && view === "cards" && (
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
      {/* §13.1: badges shared with the list view (ChallengeBadges.tsx) — add new ones there. */}
      <ChallengeNewTag challenge={challenge} />
      <div className="meta">
        <span className="chip mono">{challenge.number}</span>
        <span className={statusPillClass(challenge.status)}>{CHALLENGE_STATUS_LABEL[challenge.status] ?? challenge.status}</span>
        <span className="chip">{challenge.impactAreaName}</span>
        <ChallengeStateBadges challenge={challenge} />
      </div>
      <h3>{challenge.title}</h3>
      <div className="desc" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <AvatarBubble size="sm" userId={challenge.author.userId} displayName={challenge.author.displayName} anonymous={challenge.author.anonymous} deactivated={challenge.author.active === false} />
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span>
            <ChallengeAuthorName challenge={challenge} />
          </span>
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

// The view preference has no cross-component change source to subscribe to (the page's own clicks
// go through state), so the external-store subscription is a no-op.
function noSubscribe(): () => void {
  return () => {};
}

"use client";
// Challenges gallery (INNOBOX_SPEC.md §13.1): tabs (Open/Mine/Completed), filters
// (status/impact area/topic/namespace/author), sort (newest/most liked/most solutions), cards.
// Strictly visibility-filtered and anonymity-masked server-side — this page only renders
// what the API already decided the viewer may see. The topic filter (§34.6) lives in the URL
// (`?topic=<id>`), so a topic chip anywhere links to the filtered gallery, which then shows the
// topic's header with its Follow button.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useDateFmt } from "@/components/DateFormat";
import type { TeamPerson } from "@/components/TeamByline";
import { CHALLENGE_STATUS_LABEL, statusPillClass } from "./status";
import { readChallengesView, writeChallengesView, type ChallengesView } from "@/lib/challenges-view";
import { ChallengesList, ChallengesViewToggle } from "./ChallengesList";
import { ChallengeAuthorBubbles, ChallengeAuthorName, ChallengeNewTag, ChallengeStateBadges } from "./ChallengeBadges";
import { applyGalleryFilters, EMPTY_GALLERY_FILTERS, GalleryFilterFields, type GalleryFilterValues } from "./GalleryFilters";
import { HypeCount } from "@/components/Hype";
import { TopicChips, type TopicChipData } from "@/components/TopicChips";
import { TopicFollowButton } from "@/components/TopicFollowButton";
import { cachedGet } from "@/lib/ui";

interface ChallengeListItem {
  id: string;
  number: string;
  title: string;
  author: { userId: string | null; displayName: string; anonymous: boolean; active?: boolean; scrubbed?: boolean; external?: boolean };
  /** §39.7: the team in order — the compact form's stacked bubbles and "+N". */
  authors?: TeamPerson[];
  namespaceSlug: string;
  impactAreaName: string;
  /** §34.6: alphabetical; a retired one is muted but still filters. */
  topics: TopicChipData[];
  status: string;
  createdAt: string;
  likeCount: number;
  likedByViewer: boolean;
  solutionCount: number;
  isNew: boolean;
  /** §26.5: all-time hype points — present only while hype is on. */
  hype?: number;
}

type Tab = "open" | "mine" | "completed";
type Sort = "newest" | "most_liked" | "most_solutions" | "most_hyped";

const TABS: { key: Tab; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "mine", label: "Mine" },
  { key: "completed", label: "Completed" },
];

const SORTS: { key: Sort; label: string }[] = [
  { key: "newest", label: "Newest" },
  { key: "most_liked", label: "Most liked" },
  { key: "most_solutions", label: "Most solutions" },
  // §26.5: offered only while hype is on.
  { key: "most_hyped", label: "Most hyped" },
];

/** §34.6: the filtered gallery's header — what GET /api/topics/:id returns. */
interface TopicHeader {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  following: boolean;
}

export default function ChallengesPage() {
  // useSearchParams needs a Suspense boundary (the `topic` filter is read from the URL).
  return (
    <Suspense fallback={<p className="muted">Loading challenges…</p>}>
      <ChallengesGallery />
    </Suspense>
  );
}

function ChallengesGallery() {
  const router = useRouter();
  const params = useSearchParams();
  // §34.6: the topic filter is the URL's, so a chip on a card (or anywhere) re-filters in place.
  const topicId = params.get("topic") ?? "";
  const setTopic = (id: string) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set("topic", id);
    else next.delete("topic");
    const qs = next.toString();
    router.replace(qs ? `/challenges?${qs}` : "/challenges", { scroll: false });
  };
  const [topic, setTopicHeader] = useState<TopicHeader | null>(null);
  useEffect(() => {
    if (!topicId) {
      setTopicHeader(null);
      return;
    }
    let live = true;
    fetch(`/api/topics/${encodeURIComponent(topicId)}`, { headers: { accept: "application/json" } })
      .then(async (res) => {
        if (!live) return;
        // An unknown or deleted topic is dropped, and the gallery shows unfiltered.
        if (res.status === 404 || res.status === 400) {
          const next = new URLSearchParams(window.location.search);
          next.delete("topic");
          const qs = next.toString();
          router.replace(qs ? `/challenges?${qs}` : "/challenges", { scroll: false });
          return;
        }
        if (!res.ok) return;
        const json = (await res.json()) as { topic: TopicHeader };
        if (live) setTopicHeader(json.topic);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [topicId, router]);

  const [tab, setTab] = useState<Tab>("open");
  const [sort, setSort] = useState<Sort>("newest");
  // §26.8: the "most hyped" sort and the hype numbers exist only while hype is on.
  const [hypeOn, setHypeOn] = useState(false);
  useEffect(() => {
    cachedGet<{ hype?: { enabled: boolean } | null }>("/api/me")
      .then((me) => setHypeOn(me.hype?.enabled === true))
      .catch(() => setHypeOn(false));
  }, []);
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

  const allFilters = useMemo(() => ({ ...filters, topicId }), [filters, topicId]);
  const onFiltersChange = (next: GalleryFilterValues) => {
    if (next.topicId !== topicId) setTopic(next.topicId);
    setFilters({ ...next, topicId: "" });
  };
  const queryString = useMemo(() => applyGalleryFilters(new URLSearchParams({ tab, sort }), allFilters).toString(), [tab, sort, allFilters]);

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

      {topicId && topic && topic.id === topicId.toLowerCase() && (
        <div className="card card-pad topic-head reveal">
          <div className="topic-head-text">
            <div className="eyebrow">Topic</div>
            <h2 className="topic-head-name">{topic.name}</h2>
            {topic.description && <p className="topic-head-desc">{topic.description}</p>}
          </div>
          <div className="topic-head-actions">
            {topic.active ? (
              <TopicFollowButton topicId={topic.id} following={topic.following} onChange={(following) => setTopicHeader({ ...topic, following })} />
            ) : (
              <span className="muted topic-head-retired">This topic is retired</span>
            )}
            <button type="button" className="topic-head-clear" aria-label="Clear the topic filter" title="Clear the topic filter" onClick={() => setTopic("")}>
              ✕
            </button>
          </div>
        </div>
      )}

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
        <GalleryFilterFields value={allFilters} onChange={onFiltersChange} />
        <div className="sort-toggle">
          {SORTS.filter((s) => s.key !== "most_hyped" || hypeOn).map((s) => (
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
        {/* §34.6: inside the card's own link, so the chips navigate themselves. */}
        <TopicChips topics={challenge.topics ?? []} insideLink />
        <ChallengeStateBadges challenge={challenge} />
      </div>
      <h3>{challenge.title}</h3>
      <div className="desc" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <ChallengeAuthorBubbles challenge={challenge} />
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
        {challenge.hype !== undefined && <HypeCount value={challenge.hype} />}
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

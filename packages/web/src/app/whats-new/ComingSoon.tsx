"use client";
// "Coming soon" (INNOBOX_SPEC.md §13.9, §38): the planned, unshipped features, greyed out above the
// release list — the product's roadmap, which lives only in the database (every entry a planned row a
// platform admin approved or edited). Read from GET /api/coming-soon, which applies each entry's
// audience to the viewer's roles server-side and orders them by votes. Renders nothing until that
// answer is in — never a flash of entries the viewer should not see.
//
// The look is a "blueprint": a dashed frame with a faint hatch fading down from the heading, muted
// type and no accent colour, so nothing reads as shipped or promised. Rows are plain list items, not
// links, and carry no date, version or ETA. Each row has an upvote button — the section's only accent,
// once pressed — and the voter list, and an entry someone proposed its "Proposed by" line; those are a
// row's only focusable controls. "Propose a feature" shows to anyone who may propose (§38.11), and the
// section is hidden only when it has no entry and the viewer cannot propose.
//
// Live order (§38.3): a vote re-sorts the list at once and every row that moved slides to its new
// place (no motion under reduced motion), with a polite announcement of the voted row's new place.
// While the list is open and the tab visible, the votes are re-read every 30 seconds — a tick is
// skipped while one of the viewer's own votes is in flight, so a refresh never undoes a click the
// server has not seen yet.
//
// Collapsed by default on every visit: the heading block is the one toggle button, and the list is
// not rendered until it is opened. The open state is deliberately not remembered — the one exception
// is the `#coming-soon` fragment, which opens the section and scrolls it into view (the links in the
// §38 notifications and the profile's idea list).
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { COMING_SOON_REFRESH_MS, VOTERS_SHOWN, applyOwnVote, moveAnnouncement, othersLine, sortEntries, type Voter } from "@innobox/shared/feature-ideas";
import { AvatarBubble } from "@/components/AvatarBubble";
import { ProposeFeatureDialog } from "./ProposeFeature";

/** The fragment that opens the section (§13.9). */
export const COMING_SOON_HASH = "#coming-soon";

/** A resumed list (re-opened, or the tab shown again) re-reads at once when its data is older. */
const RESUME_STALE_MS = 5_000;

interface Person {
  id: string;
  displayName: string;
  deactivated: boolean;
}

interface Entry {
  id: string;
  title: string;
  teaser: string;
  approvedAt: string;
  votes: number;
  voted: boolean;
  voters: Voter[];
  othersCount: number;
  othersIncludesYou: boolean;
  proposedBy: Person | null;
}

interface ComingSoonData {
  entries: Entry[];
  canPropose: boolean;
  myPendingCount: number;
  /** Null for a platform admin, who has no pending cap. */
  maxPending: number | null;
  named: boolean;
}

type VoteState = Pick<Entry, "voted" | "votes" | "voters" | "othersCount" | "othersIncludesYou">;

const EMPTY: ComingSoonData = { entries: [], canPropose: false, myPendingCount: 0, maxPending: null, named: true };

async function fetchComingSoon(): Promise<ComingSoonData | null> {
  try {
    const res = await fetch("/api/coming-soon", { headers: { accept: "application/json" } });
    return res.ok ? ((await res.json()) as ComingSoonData) : null;
  } catch {
    return null;
  }
}

export function ComingSoon() {
  const [data, setData] = useState<ComingSoonData | null>(null);
  const [open, setOpen] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [voteErrors, setVoteErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [announcement, setAnnouncement] = useState("");
  // The rise-in stagger of the rows present when the list opened. A row that arrives later (or a
  // re-sort) never changes its delay, or a row that already rose would drop back into it and blink.
  const [stagger, setStagger] = useState<ReadonlyMap<string, number>>(new Map());
  const listId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const proposeRef = useRef<HTMLButtonElement>(null);
  // The latest data, for handlers that must not act on a stale render's copy.
  const dataRef = useRef<ComingSoonData | null>(null);
  useLayoutEffect(() => {
    dataRef.current = data;
  }, [data]);
  // Votes in flight, and a counter bumped by each one: a refresh that started before a vote is dropped.
  const inFlight = useRef(0);
  const voteEpoch = useRef(0);
  const lastReadAt = useRef(0);

  const load = useCallback(async () => {
    const json = await fetchComingSoon();
    lastReadAt.current = Date.now();
    setData(json ?? (dataRef.current ? dataRef.current : EMPTY));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** §38.3: the live refresh — other people's votes, new and removed entries, edited copy. */
  const refresh = useCallback(async () => {
    if (inFlight.current > 0) return;
    const started = voteEpoch.current;
    const json = await fetchComingSoon();
    if (!json || inFlight.current > 0 || voteEpoch.current !== started) return;
    lastReadAt.current = Date.now();
    setData(json);
  }, []);

  // While the list is open and the tab visible: a read every 30 s, and one at once on resuming.
  useEffect(() => {
    if (!open) return;
    let timer: number | null = null;
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const resume = () => {
      stop();
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastReadAt.current > RESUME_STALE_MS) void refresh();
      timer = window.setInterval(() => void refresh(), COMING_SOON_REFRESH_MS);
    };
    resume();
    document.addEventListener("visibilitychange", resume);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", resume);
    };
  }, [open, refresh]);

  const openList = useCallback(() => {
    setStagger(new Map((dataRef.current?.entries ?? []).map((e, i) => [e.id, i * 0.04])));
    setOpen(true);
  }, []);

  // §13.9: `#coming-soon` opens the section and brings it into view — once, when the entries first
  // arrive, and again whenever the fragment is set later; a refresh never re-scrolls.
  const loaded = data !== null;
  useEffect(() => {
    if (!loaded) return;
    const openFromHash = () => {
      if (window.location.hash !== COMING_SOON_HASH) return;
      openList();
      window.requestAnimationFrame(() => sectionRef.current?.scrollIntoView({ block: "start" }));
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, [loaded, openList]);

  // §38.3: rows slide to their new place. Each row's offset is remembered after every render; a row
  // that moved starts from its old offset and transitions to the new one (FLIP). Offsets are taken
  // inside the list, so scrolling the page never reads as a move.
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const lastOffsets = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const offsets = new Map<string, number>();
    for (const [id, el] of rowRefs.current) offsets.set(id, el.offsetTop);
    if (!reduce) {
      for (const [id, el] of rowRefs.current) {
        const before = lastOffsets.current.get(id);
        const after = offsets.get(id)!;
        if (before === undefined || before === after) continue;
        el.style.transition = "none";
        el.style.transform = `translateY(${before - after}px)`;
        void el.offsetHeight; // commit the starting point before transitioning away from it
        el.style.transition = "transform 0.2s ease";
        el.style.transform = "";
      }
    }
    lastOffsets.current = offsets;
  });
  const rowRef = (id: string) => (el: HTMLLIElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else {
      rowRefs.current.delete(id);
      lastOffsets.current.delete(id);
    }
  };

  const setEntries = (entries: Entry[]) => setData((d) => (d ? { ...d, entries } : d));

  // §38.3: one click toggles — flipped and re-sorted at once, reconciled with the server's state, and
  // reverted with a short inline error when it fails.
  const toggleVote = async (entry: Entry) => {
    const current = dataRef.current;
    if (!current || busy[entry.id]) return;
    const voted = !entry.voted;
    const next = applyOwnVote(current.entries, entry.id, voted);
    inFlight.current += 1;
    voteEpoch.current += 1;
    setBusy((b) => ({ ...b, [entry.id]: true }));
    setVoteErrors((e) => ({ ...e, [entry.id]: "" }));
    setEntries(next);
    const moved = moveAnnouncement(current.entries, next, entry.id);
    if (moved) setAnnouncement(moved);
    try {
      const res = await fetch("/api/coming-soon/votes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entry: entry.id }),
      });
      if (res.status === 404) {
        // Deleted, or narrowed out of the viewer's audience, meanwhile: the row leaves the list.
        setEntries((dataRef.current?.entries ?? []).filter((x) => x.id !== entry.id));
        return;
      }
      if (!res.ok) throw new Error();
      const state = (await res.json()) as VoteState;
      setEntries(sortEntries((dataRef.current?.entries ?? []).map((x) => (x.id === entry.id ? { ...x, ...state } : x))));
    } catch {
      setEntries(applyOwnVote(dataRef.current?.entries ?? [], entry.id, entry.voted));
      setVoteErrors((e) => ({ ...e, [entry.id]: "Your vote wasn't saved. Try again." }));
    } finally {
      inFlight.current -= 1;
      setBusy((b) => ({ ...b, [entry.id]: false }));
    }
  };

  if (!data) return null;
  if (data.entries.length === 0 && !data.canPropose) return null;
  const count = data.entries.length;

  return (
    <section ref={sectionRef} id="coming-soon" className={open ? "soon open reveal" : "soon reveal"} style={{ animationDelay: "0.04s" }}>
      <div className="soon-header">
        <h2 className="soon-heading">
          <button type="button" className="soon-head" aria-expanded={open} aria-controls={listId} onClick={() => (open ? setOpen(false) : openList())}>
            <span className="soon-icon" aria-hidden="true">
              <CompassIcon />
            </span>
            <span className="soon-headtext">
              <span className="soon-title">
                Coming soon {count > 0 && <span className="soon-count">· {count}</span>}
              </span>
              <span className="soon-sub">Planned, not available yet. Plans can change.</span>
            </span>
            <span className="soon-chevron" aria-hidden="true">
              <ChevronIcon />
            </span>
          </button>
        </h2>
        {data.canPropose && (
          <button ref={proposeRef} type="button" className="btn btn-sm soon-propose" data-testid="propose-feature" onClick={() => setProposing(true)}>
            Propose a feature
          </button>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {open && count === 0 && (
        <p className="soon-empty" id={listId}>
          Nothing planned yet. Propose the first feature.
        </p>
      )}
      {open && count > 0 && (
        <ul className="soon-list" id={listId} aria-label="Coming soon">
          {data.entries.map((entry) => (
            <li
              ref={rowRef(entry.id)}
              className="soon-item has-vote"
              key={entry.id}
              data-testid="soon-item"
              data-entry-id={entry.id}
              style={{ animationDelay: `${stagger.get(entry.id) ?? 0}s` }}
            >
              <span className="soon-mark" aria-hidden="true">
                <SparkIcon />
              </span>
              <div className="soon-body">
                <div className="soon-line">
                  <span className="soon-name">{entry.title}</span>
                  <span className="chip soon-chip">Coming soon</span>
                </div>
                <p className="soon-teaser">{entry.teaser}</p>
                {entry.proposedBy && (
                  <div className="soon-by" data-testid="soon-proposed-by">
                    <span>Proposed by</span>
                    <AvatarBubble size="sm" userId={entry.proposedBy.id} displayName={entry.proposedBy.displayName} deactivated={entry.proposedBy.deactivated} />
                    <span className="soon-by-name">{entry.proposedBy.displayName}</span>
                  </div>
                )}
                <VoterList entry={entry} />
                {voteErrors[entry.id] && (
                  <p className="soon-error" role="status">
                    {voteErrors[entry.id]}
                  </p>
                )}
              </div>
              <button
                type="button"
                className={entry.voted ? "soon-vote is-on" : "soon-vote"}
                aria-pressed={entry.voted}
                aria-label={entry.voted ? `Remove your upvote: ${entry.title}` : `Upvote: ${entry.title}`}
                title={entry.voted ? `Remove your upvote: ${entry.title}` : `Upvote: ${entry.title}`}
                data-testid="soon-vote"
                onClick={() => toggleVote(entry)}
              >
                <UpvoteIcon />
                <span className="soon-vote-count">{entry.votes}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {proposing && (
        <ProposeFeatureDialog
          named={data.named !== false}
          atCap={data.maxPending !== null && data.myPendingCount >= data.maxPending}
          onSent={() => void load()}
          onClose={() => {
            setProposing(false);
            proposeRef.current?.focus();
          }}
        />
      )}
    </section>
  );
}

/** §38.3: the named voters, newest first — 12 bubbles, then "+N" to show the rest — and one muted
 *  line for the voters who are counted but not named. Nothing until the entry has a vote. */
function VoterList({ entry }: { entry: Entry }) {
  const [expanded, setExpanded] = useState(false);
  const voters = entry.voters;
  const others = entry.othersCount;
  if (voters.length === 0 && others === 0) return null;
  const shown = expanded ? voters : voters.slice(0, VOTERS_SHOWN);
  const more = voters.length - shown.length;
  return (
    <div className="soon-voters" data-testid="soon-voters">
      <span className="sub">Upvoted by</span>
      {shown.length > 0 && (
        <span className="hypers-bubbles">
          {shown.map((v) => (
            <AvatarBubble key={v.id} size="sm" userId={v.id} displayName={v.displayName} deactivated={v.deactivated} />
          ))}
        </span>
      )}
      {more > 0 && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setExpanded(true)} aria-label={`Show ${more} more`}>
          +{more}
        </button>
      )}
      {others > 0 && <span className="sub">{othersLine(others, entry.othersIncludesYou, voters.length > 0)}</span>}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function UpvoteIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 15l6-6 6 6" />
    </svg>
  );
}

function CompassIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 8.5l-2 5-5 2 2-5 5-2z" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.5 6.5l2.5 2.5M15 15l2.5 2.5M6.5 17.5L9 15M15 9l2.5-2.5" />
    </svg>
  );
}

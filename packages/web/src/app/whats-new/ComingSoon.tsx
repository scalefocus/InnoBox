"use client";
// "Coming soon" (INNOBOX_SPEC.md §13.9, §38): the planned, unshipped features, greyed out above the
// release list — the teasers this specification defines and the community ideas a platform admin
// approved, read together from GET /api/coming-soon, which applies each entry's audience to the
// viewer's roles server-side and orders them by votes. Renders nothing until that answer is in —
// never a flash of entries the viewer should not see.
//
// The look is a "blueprint": a dashed frame with a faint hatch fading down from the heading, muted
// type and no accent colour, so nothing reads as shipped or promised. Rows are plain list items, not
// links, and carry no date, version or ETA. While feature ideas are on (§38.11) each row also has an
// upvote button — the section's only accent, once pressed — and the voter list, and a community idea
// its "Proposed by" line; those are a row's only focusable controls. The section then always shows,
// so "Propose a feature" can be reached; while they are off it is the read-only list of §13.9,
// hidden when no teaser applies.
//
// Collapsed by default on every visit: the heading block is the one toggle button, and the list is
// not rendered until it is opened. The open state is deliberately not remembered — the one exception
// is the `#coming-soon` fragment, which opens the section and scrolls it into view (the links in the
// §38 notifications and the profile's idea list).
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { MAX_PENDING_IDEAS, VOTERS_SHOWN, othersLine, type Voter } from "@innobox/shared/feature-ideas";
import { AvatarBubble } from "@/components/AvatarBubble";
import { ProposeFeatureDialog } from "./ProposeFeature";

/** The fragment that opens the section (§13.9). */
export const COMING_SOON_HASH = "#coming-soon";

interface Person {
  id: string;
  displayName: string;
  deactivated: boolean;
}

interface Entry {
  id: string;
  kind: "spec" | "idea";
  title: string;
  teaser: string;
  // Present while feature ideas are on.
  votes?: number;
  voted?: boolean;
  voters?: Voter[];
  othersCount?: number;
  othersIncludesYou?: boolean;
  proposedBy?: Person | null;
}

interface ComingSoonData {
  enabled: boolean;
  entries: Entry[];
  myPendingCount?: number;
  maxPending?: number;
  named?: boolean;
}

export function ComingSoon() {
  const [data, setData] = useState<ComingSoonData | null>(null);
  const [open, setOpen] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [voteErrors, setVoteErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const listId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const proposeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(() => {
    fetch("/api/coming-soon", { headers: { accept: "application/json" } })
      .then((res) => (res.ok ? (res.json() as Promise<ComingSoonData>) : null))
      .then((json) => setData(json ?? { enabled: false, entries: [] }))
      .catch(() => setData({ enabled: false, entries: [] }));
  }, []);

  useEffect(() => load(), [load]);

  // §13.9: `#coming-soon` opens the section and brings it into view — once, when the entries first
  // arrive, and again whenever the fragment is set later; a reload after a vote never re-scrolls.
  const loaded = data !== null;
  useEffect(() => {
    if (!loaded) return;
    const openFromHash = () => {
      if (window.location.hash !== COMING_SOON_HASH) return;
      setOpen(true);
      window.requestAnimationFrame(() => sectionRef.current?.scrollIntoView({ block: "start" }));
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, [loaded]);

  // §38.3: one click toggles — flipped at once, reconciled with the server's state, reverted with a
  // short inline error when it fails.
  const toggleVote = async (entry: Entry) => {
    if (busy[entry.id]) return;
    const voted = !entry.voted;
    const optimistic = { voted, votes: (entry.votes ?? 0) + (voted ? 1 : -1) };
    setBusy((b) => ({ ...b, [entry.id]: true }));
    setVoteErrors((e) => ({ ...e, [entry.id]: "" }));
    setData((d) => (d ? { ...d, entries: d.entries.map((x) => (x.id === entry.id ? { ...x, ...optimistic } : x)) } : d));
    try {
      const res = await fetch("/api/coming-soon/votes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entry: entry.id }),
      });
      if (!res.ok) throw new Error();
      const state = (await res.json()) as Pick<Entry, "voted" | "votes" | "voters" | "othersCount" | "othersIncludesYou">;
      setData((d) => (d ? { ...d, entries: d.entries.map((x) => (x.id === entry.id ? { ...x, ...state } : x)) } : d));
    } catch {
      setData((d) => (d ? { ...d, entries: d.entries.map((x) => (x.id === entry.id ? { ...x, voted: entry.voted, votes: entry.votes } : x)) } : d));
      setVoteErrors((e) => ({ ...e, [entry.id]: "Your vote wasn't saved. Try again." }));
    } finally {
      setBusy((b) => ({ ...b, [entry.id]: false }));
    }
  };

  if (!data) return null;
  if (!data.enabled && data.entries.length === 0) return null;
  const count = data.entries.length;

  return (
    <section ref={sectionRef} id="coming-soon" className={open ? "soon open reveal" : "soon reveal"} style={{ animationDelay: "0.04s" }}>
      <div className="soon-header">
        <h2 className="soon-heading">
          <button type="button" className="soon-head" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
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
        {data.enabled && (
          <button ref={proposeRef} type="button" className="btn btn-sm soon-propose" data-testid="propose-feature" onClick={() => setProposing(true)}>
            Propose a feature
          </button>
        )}
      </div>
      {open && count === 0 && (
        <p className="soon-empty" id={listId}>
          Nothing planned yet. Propose the first feature.
        </p>
      )}
      {open && count > 0 && (
        <ul className="soon-list" id={listId} aria-label="Coming soon">
          {data.entries.map((entry, i) => (
            <li
              className={data.enabled ? "soon-item has-vote" : "soon-item"}
              key={entry.id}
              data-kind={entry.kind}
              data-testid="soon-item"
              style={{ animationDelay: `${i * 0.04}s` }}
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
                {data.enabled && <VoterList entry={entry} />}
                {voteErrors[entry.id] && (
                  <p className="soon-error" role="status">
                    {voteErrors[entry.id]}
                  </p>
                )}
              </div>
              {data.enabled && (
                <button
                  type="button"
                  className={entry.voted ? "soon-vote is-on" : "soon-vote"}
                  aria-pressed={entry.voted === true}
                  aria-label={entry.voted ? `Remove your upvote: ${entry.title}` : `Upvote: ${entry.title}`}
                  title={entry.voted ? `Remove your upvote: ${entry.title}` : `Upvote: ${entry.title}`}
                  data-testid="soon-vote"
                  onClick={() => toggleVote(entry)}
                >
                  <UpvoteIcon />
                  <span className="soon-vote-count">{entry.votes ?? 0}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {proposing && (
        <ProposeFeatureDialog
          named={data.named !== false}
          atCap={(data.myPendingCount ?? 0) >= (data.maxPending ?? MAX_PENDING_IDEAS)}
          onSent={load}
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
  const voters = entry.voters ?? [];
  const others = entry.othersCount ?? 0;
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
      {others > 0 && <span className="sub">{othersLine(others, entry.othersIncludesYou === true, voters.length > 0)}</span>}
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

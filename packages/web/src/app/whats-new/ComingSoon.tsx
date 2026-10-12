"use client";
// "Coming soon" (INNOBOX_SPEC.md §13.9): the specified-but-unshipped features, greyed out above
// the release list. Filtered by the viewer's roles from the `me` resource, so admin-only tooling
// is teased only to the people who will use it. Renders nothing until `me` has loaded — never a
// flash of entries the viewer should not see — and nothing at all when no entry applies.
//
// The look is a "blueprint": a dashed frame with a faint hatch fading down from the heading,
// muted type and no accent colour, so nothing reads as shipped, clickable or promised. Rows are
// plain list items — not links, not focusable — and carry no date, version or ETA.
//
// Collapsed by default on every visit: the heading block is the one toggle button, and the list
// is not rendered until it is opened. The open state is deliberately not remembered.
import { useEffect, useId, useState } from "react";
import { cachedGet } from "../../lib/ui";
import { upcomingFor, type UpcomingEntry, type UpcomingViewer } from "./upcoming";

interface MeRoles {
  roles: UpcomingViewer;
}

export function ComingSoon() {
  const [entries, setEntries] = useState<UpcomingEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  const listId = useId();

  useEffect(() => {
    let live = true;
    cachedGet<MeRoles>("/api/me")
      .then((me) => {
        if (live) setEntries(upcomingFor(me.roles));
      })
      .catch(() => {
        // Without roles, show only what everyone may see.
        if (live) setEntries(upcomingFor({ platformAdmin: false, namespaceAdmin: [] }));
      });
    return () => {
      live = false;
    };
  }, []);

  if (!entries || entries.length === 0) return null;

  return (
    <section className={open ? "soon open reveal" : "soon reveal"} style={{ animationDelay: "0.04s" }}>
      <h2 className="soon-heading">
        <button
          type="button"
          className="soon-head"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="soon-icon" aria-hidden="true">
            <CompassIcon />
          </span>
          <span className="soon-headtext">
            <span className="soon-title">
              Coming soon <span className="soon-count">· {entries.length}</span>
            </span>
            <span className="soon-sub">Planned and specified, not available yet. Plans can change.</span>
          </span>
          <span className="soon-chevron" aria-hidden="true">
            <ChevronIcon />
          </span>
        </button>
      </h2>
      {open && (
        <ul className="soon-list" id={listId} aria-label="Coming soon">
          {entries.map((entry, i) => (
            <li className="soon-item" key={entry.ids.join(",")} style={{ animationDelay: `${i * 0.04}s` }}>
              <span className="soon-mark" aria-hidden="true">
                <SparkIcon />
              </span>
              <div className="soon-body">
                <div className="soon-line">
                  <span className="soon-name">{entry.title}</span>
                  <span className="chip soon-chip">Coming soon</span>
                </div>
                <p className="soon-teaser">{entry.teaser}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ChevronIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
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

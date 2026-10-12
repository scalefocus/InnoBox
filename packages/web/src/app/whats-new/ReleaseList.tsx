"use client";
// The /whats-new release list (INNOBOX_SPEC.md §13.9) — the client half of the page, for
// everything that reads `/api/me` or the query string:
//
//   - Read receipt: on mount the page stamps the marker at the client APP_VERSION, whichever
//     route brought the user here, and tells AppShell to close any open update notice.
//   - "New since your last visit": the missed entries are highlighted and grouped above a
//     labelled divider. The boundary is `?since=`, else the marker as it stood BEFORE this
//     page's own stamp (the stamp response's `previous`), else the one-time rollout date.
//   - The running release carries a "current" label.
//
// Dates are UTC calendar dates shown verbatim — release stamps, not timestamps, so they never
// pass through the date formatter. Until the boundary resolves the list renders plainly.
import { useEffect, useRef, useState } from "react";
import { APP_VERSION } from "@innobox/shared/version";
import { cachedGet, invalidateApi } from "../../lib/ui";
import { entriesPast, isVersion, resolvePageBoundary, type MissedBoundary } from "../../lib/whats-new";
import { WHATS_NEW_SEEN_EVENT, stampWhatsNewSeen, type WhatsNewMe } from "../../components/WhatsNewNotice";
import { CHANGELOG, type ChangelogEntry } from "./changelog";

async function acknowledgeAndResolve(since: string | null): Promise<MissedBoundary | null> {
  const me = await cachedGet<WhatsNewMe>("/api/me").catch(() => null);
  const stamp = await stampWhatsNewSeen();
  window.dispatchEvent(new Event(WHATS_NEW_SEEN_EVENT));
  invalidateApi("/api/me");
  return resolvePageBoundary({
    since,
    // A failed stamp leaves the marker untouched, so the `me` read is still "before the stamp".
    markerBeforeStamp: stamp ? stamp.previous : (me?.whatsNewSeenVersion ?? null),
    sinceDate: me?.whatsNewSinceDate ?? null,
  });
}

export function ReleaseList() {
  const [boundary, setBoundary] = useState<MissedBoundary | null>(null);
  // One stamp per mount, even when the effect runs twice in development (strict mode) — a second
  // stamp would read back the version the first just wrote and lose the highlighting.
  const pending = useRef<Promise<MissedBoundary | null> | null>(null);

  useEffect(() => {
    let live = true;
    const since = new URLSearchParams(window.location.search).get("since");
    // A valid `?since=` wins outright — highlight at once, without waiting on the stamp.
    if (isVersion(since)) setBoundary({ kind: "version", version: since });
    pending.current ??= acknowledgeAndResolve(since);
    void pending.current.then((resolved) => {
      if (live) setBoundary(resolved);
    });
    return () => {
      live = false;
    };
  }, []);

  const missed = boundary ? entriesPast(CHANGELOG, boundary) : [];
  const missedVersions = new Set(missed.map((e) => e.version));
  const older = CHANGELOG.filter((e) => !missedVersions.has(e.version));

  if (missed.length === 0) {
    return (
      <div className="rows reveal" style={{ animationDelay: "0.08s" }}>
        {CHANGELOG.map((entry) => (
          <ReleaseRow key={entry.version} entry={entry} isNew={false} />
        ))}
      </div>
    );
  }

  return (
    <div className="reveal" style={{ animationDelay: "0.08s" }}>
      <div className="rows" aria-label="New since your last visit" role="group">
        {missed.map((entry) => (
          <ReleaseRow key={entry.version} entry={entry} isNew />
        ))}
      </div>
      <div className="release-divider" data-testid="whats-new-divider">
        New since your last visit
      </div>
      {older.length > 0 && (
        <div className="rows">
          {older.map((entry) => (
            <ReleaseRow key={entry.version} entry={entry} isNew={false} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReleaseRow({ entry, isNew }: { entry: ChangelogEntry; isNew: boolean }) {
  const current = entry.version === APP_VERSION;
  return (
    <div className={isNew ? "row release-row is-new" : "row release-row"} data-version={entry.version}>
      <span className="chip chip-accent">v{entry.version}</span>
      <div className="grow">
        <div className="ttl">{entry.summary}</div>
      </div>
      {(isNew || current) && (
        <span className="release-tags">
          {isNew && <span className="chip release-tag-new">New</span>}
          {current && <span className="chip release-tag-current">current</span>}
        </span>
      )}
      <span className="mono muted release-date">{entry.date}</span>
    </div>
  );
}

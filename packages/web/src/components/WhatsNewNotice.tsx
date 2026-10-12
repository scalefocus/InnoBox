"use client";
// The What's new update notice (INNOBOX_SPEC.md §13.9): a floating status card that tells a
// returning user something changed since they last acknowledged a release, with a link to exactly
// what they missed. Owned by AppShell, so it survives client-side navigation; stamped only on
// dismissal, so it also survives reloads and new tabs until the user acts on it.
//
//   - Evaluated against the CLIENT bundle's APP_VERSION — the version the page lists — so a stale
//     cached bundle or a rollback shows nothing and never touches the marker.
//   - `role="status"`: a polite live region. It never takes focus, traps nothing and ignores
//     Escape and outside clicks — the ✕ and the link are the only two ways to dismiss it.
//   - The changelog is imported lazily, only when the rule says "show", so the summaries stay out
//     of the shell bundle on every other load.
//   - The /whats-new page acknowledges on mount and announces it with `innobox:whats-new-seen`;
//     the notice closes on that event and never opens while the page is showing.
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { APP_VERSION } from "@innobox/shared/version";
import type { ChangelogEntry } from "../app/whats-new/changelog";
import {
  missedEntries,
  noticeExcerpt,
  noticeLinkLabel,
  sinceForLink,
  whatsNewAction,
} from "../lib/whats-new";

/** Window event the /whats-new page dispatches once it has stamped the marker. */
export const WHATS_NEW_SEEN_EVENT = "innobox:whats-new-seen";

/** Fire-and-forget stamp. A failure is neither retried nor surfaced: the notice simply returns
 *  on the next load. */
export function stampWhatsNewSeen(): Promise<{ previous: string | null; current: string | null } | null> {
  return fetch("/api/me/whats-new-seen", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ version: APP_VERSION }),
  })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
}

export interface WhatsNewMe {
  quickStartSeenAt: string | null;
  whatsNewSeenVersion: string | null;
  whatsNewSinceDate: string | null;
}

/** `onClosed` tells the shell the notice is gone for this load (dismissed, or acknowledged on the
 *  page), so the §13.10 feedback survey — which never shows while the notice is due — may. */
export function WhatsNewNotice({ me, pathname, onClosed }: { me: WhatsNewMe | null; pathname: string; onClosed?: () => void }) {
  const action = me ? whatsNewAction(me.whatsNewSeenVersion, APP_VERSION, me.quickStartSeenAt !== null) : "none";
  const [closed, setClosed] = useState(false);
  const [changelog, setChangelog] = useState<ChangelogEntry[] | null>(null);
  const onPage = pathname === "/whats-new";

  // The page acknowledges the release on mount — nothing left to announce for this load.
  useEffect(() => {
    if (onPage) setClosed(true);
  }, [onPage]);

  useEffect(() => {
    const onSeen = () => setClosed(true);
    window.addEventListener(WHATS_NEW_SEEN_EVENT, onSeen);
    return () => window.removeEventListener(WHATS_NEW_SEEN_EVENT, onSeen);
  }, []);

  useEffect(() => {
    if (action !== "show" || closed || changelog) return;
    let live = true;
    import("../app/whats-new/changelog")
      .then((mod) => {
        if (live) setChangelog(mod.CHANGELOG);
      })
      .catch(() => {
        /* no notice this load */
      });
    return () => {
      live = false;
    };
  }, [action, closed, changelog]);

  const dismiss = useCallback(() => {
    setClosed(true); // optimistic
    onClosed?.();
    void stampWhatsNewSeen();
  }, [onClosed]);

  if (action !== "show" || closed || onPage || !changelog || !me) return null;

  const missed = missedEntries(changelog, {
    seen: me.whatsNewSeenVersion,
    sinceDate: me.whatsNewSinceDate,
    current: APP_VERSION,
  });
  if (missed.length === 0) return null;

  return createPortal(
    <NoticeCard
      excerpt={noticeExcerpt(missed)}
      label={noticeLinkLabel(missed, APP_VERSION)}
      href={`/whats-new?since=${encodeURIComponent(sinceForLink(changelog, missed))}`}
      onDismiss={dismiss}
    />,
    document.body,
  );
}

function NoticeCard({
  excerpt,
  label,
  href,
  onDismiss,
}: {
  excerpt: ChangelogEntry[];
  label: string;
  href: string;
  onDismiss: () => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const [overflows, setOverflows] = useState(false);

  // Only an overflowing list joins the Tab order (✕ → list → link), so a keyboard user can
  // scroll it; a list that fits stays out of the way.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const check = () => setOverflows(list.scrollHeight > list.clientHeight);
    check();
    window.addEventListener("resize", check);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(check);
    observer?.observe(list);
    return () => {
      window.removeEventListener("resize", check);
      observer?.disconnect();
    };
  }, [excerpt]);

  return (
    <div className="update-notice" role="status" data-testid="whats-new-notice">
      <div className="update-notice-head">
        <p className="update-notice-title">
          What&apos;s new in <span className="chip chip-accent update-notice-chip">v{APP_VERSION}</span>
        </p>
        <button type="button" className="update-notice-close" aria-label="Dismiss" onClick={onDismiss}>
          ✕
        </button>
      </div>
      <ul
        ref={listRef}
        className="update-notice-list"
        tabIndex={overflows ? 0 : undefined}
        aria-label={overflows ? "Release notes" : undefined}
      >
        {excerpt.map((entry) => (
          <li key={entry.version}>{entry.summary}</li>
        ))}
      </ul>
      <Link className="update-notice-link" href={href} onClick={onDismiss}>
        {label}
      </Link>
    </div>
  );
}

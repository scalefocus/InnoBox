"use client";
// Topbar search (INNOBOX_SPEC.md §13.4): a live autocomplete dropdown over /api/search,
// reusing the pre-built .search/.search-ac class contract. Enter or "See all results"
// navigates to the full /search page; results are already visibility-filtered/masked.
import { useRouter } from "next/navigation";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

interface SearchItem {
  number: string;
  title?: string;
  description?: string;
  challengeNumber?: string;
}

// Imperative handle so AppShell's global Ctrl+K/Cmd+K listener (INNOBOX_SPEC.md §13.4)
// can focus this field from outside without lifting its query state.
export interface TopbarSearchHandle {
  focus: () => void;
  isActive: () => boolean;
}

export const TopbarSearch = forwardRef<TopbarSearchHandle>(function TopbarSearch(_props, ref) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [challenges, setChallenges] = useState<SearchItem[]>([]);
  const [solutions, setSolutions] = useState<SearchItem[]>([]);
  // OS-aware shortcut-hint label (INNOBOX_SPEC.md §13.4). Starts false so the server render and
  // the first client render agree (no hydration mismatch); the effect flips it to ⌘K on Macs
  // post-hydration. navigator.platform is deprecated but still the most reliable Mac tell here.
  const [isMac, setIsMac] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setIsMac(/mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent));
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => {
      inputRef.current?.focus();
      inputRef.current?.select();
      setOpen(true);
    },
    isActive: () => inputRef.current === document.activeElement,
  }));

  useEffect(() => {
    if (query.trim().length < 2) {
      setChallenges([]);
      setSolutions([]);
      return;
    }
    let live = true;
    const timeout = window.setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}`, { headers: { accept: "application/json" } })
        .then((res) => res.json())
        .then((json) => {
          if (!live) return;
          setChallenges((json.challenges ?? []).slice(0, 4));
          setSolutions((json.solutions ?? []).slice(0, 4));
        })
        .catch(() => {});
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timeout);
    };
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const goToAll = () => {
    setOpen(false);
    router.push(`/search?q=${encodeURIComponent(query)}`);
  };

  const goToChallenge = (number: string) => {
    setOpen(false);
    router.push(`/challenges/${number.replace("CH-", "")}`);
  };

  // Clear the field and keep focus so the user can retype (INNOBOX_SPEC.md §13.4).
  // The dropdown collapses on its own once the query is empty (it needs ≥2 chars).
  const clearQuery = () => {
    setQuery("");
    inputRef.current?.focus();
  };

  const hasResults = challenges.length > 0 || solutions.length > 0;

  return (
    <div className="search" ref={rootRef} style={{ position: "relative" }}>
      <SearchIcon />
      <input
        ref={inputRef}
        placeholder="Search challenges & solutions…"
        value={query}
        aria-keyshortcuts="Control+K Meta+K"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && query.trim() !== "") goToAll();
          // Progressive Escape (INNOBOX_SPEC.md §13.4): clear the field if it has text
          // (keeping focus); on an already-empty field, exit the field. Clearing also
          // collapses the dropdown as a side effect (empty query → below the ≥2-char threshold).
          if (e.key === "Escape") {
            if (query !== "") setQuery("");
            else inputRef.current?.blur();
          }
        }}
      />
      {/* Clear button (INNOBOX_SPEC.md §13.4): a ✕ in a semi-transparent circle, shown from the
          first character. Shares the right-edge slot with the shortcut pill (which is hidden on
          focus, so they never collide) and is suppressed on mobile via CSS. Kept out of the tab
          order — Escape is the keyboard path to clearing. */}
      {query.length > 0 && (
        <button type="button" className="search-clear" aria-label="Clear search" tabIndex={-1} onClick={clearQuery}>
          <ClearIcon />
        </button>
      )}
      {/* Discoverability hint (INNOBOX_SPEC.md §13.4): reuses the pre-built .search kbd pill.
          Decorative for AT (the input's aria-keyshortcuts carries the real signal); hidden on
          focus and on mobile via CSS. */}
      <kbd className="search-hint" aria-hidden="true">
        {isMac ? "⌘K" : "Ctrl+K"}
      </kbd>
      {/* A popover (INNOBOX_SPEC.md §2.2, §13.4): `.menu-pop` fades + scales it in once, when it
          first appears. This <ul> must stay the same mounted element while results refresh (no
          key, no wrapper that toggles), so the open animation never replays as you type. */}
      {open && query.trim().length >= 2 && (
        <ul className="search-ac menu-pop">
          {!hasResults && (
            <li className="search-ac-empty">
              No matches for <span className="mono">{query}</span>
            </li>
          )}
          {challenges.map((c) => (
            <li key={c.number}>
              <button type="button" className="search-ac-item" onClick={() => goToChallenge(c.number)}>
                <span className="search-ac-title">{c.title}</span>
                <span className="search-ac-sub mono">{c.number}</span>
              </button>
            </li>
          ))}
          {solutions.map((s) => (
            <li key={s.number}>
              <button type="button" className="search-ac-item" onClick={() => goToChallenge(s.challengeNumber ?? "")}>
                <span className="search-ac-title">{s.description}</span>
                <span className="search-ac-sub mono">
                  {s.number} · {s.challengeNumber}
                </span>
              </button>
            </li>
          ))}
          {hasResults && (
            <li>
              <button type="button" className="search-ac-item search-ac-all" onClick={goToAll}>
                See all results for &ldquo;{query}&rdquo;
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
});

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

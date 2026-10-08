"use client";
// Directory hover card (INNOBOX_SPEC.md §13.8): hovering an avatar bubble opens a small floating
// card with that person's Entra directory profile — job title, department, office location — plus a
// link to their full profile (§13.5).
//
// This module owns the interaction; AvatarBubble owns the trigger. It deliberately does NOT import
// AvatarBubble (that would be a cycle): the caller passes its own rendered bubble in as `avatar`.
//
// Anonymity (invariant 3): nothing here ever runs for an anonymous bubble — AvatarBubble only
// enables the card for a real user id, and an anonymous author's id never reaches the client. The
// gate lives at the call site so that an anonymous bubble has no handlers, no tab stop and issues
// no request: nothing in the DOM or the network log distinguishes two anonymous authors.
//
// Touch: the card is mouse-only (`pointerType === "mouse"`). There is no long-press affordance, so
// avatars keep their native touch/context behavior and a tap inside a clickable triage row still
// opens the row (§14.1). On touch the directory profile is reached through the profile page.
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const OPEN_DELAY_MS = 300; // hover intent — a pointer crossing a dense table must not fire cards
const CLOSE_DELAY_MS = 150; // grace period so the pointer can travel into the card ("View profile")
const GAP_PX = 8; // gap between the bubble and the card
const EDGE_PX = 8; // minimum distance from the viewport edge
const FALLBACK_W = 280; // card max-width, used before the card has been measured

/** The payload of `GET /api/users/:id/card` (§13.8). */
export interface UserCardData {
  userId: string;
  displayName: string;
  jobTitle: string | null;
  officeLocation: string | null;
  department: string | null;
  deactivated: boolean;
  scrubbed: boolean;
}

// Per-page-session dedupe + cache: two bubbles for the same person share one request, and
// re-hovering is instant with no flicker. A failed lookup is evicted so a later hover retries.
const cache = new Map<string, Promise<UserCardData | null>>();

function loadCard(userId: string): Promise<UserCardData | null> {
  const hit = cache.get(userId);
  if (hit) return hit;
  const pending = fetch(`/api/users/${userId}/card`, { headers: { accept: "application/json" } })
    .then((res) => (res.ok ? res.json() : null))
    .then((json) => (json?.card ?? null) as UserCardData | null)
    .catch(() => null)
    .then((card) => {
      if (!card) cache.delete(userId); // transient failure / 404 — don't poison the page session
      return card;
    });
  cache.set(userId, pending);
  return pending;
}

/** One card at a time — opening a second closes the first (§13.8). */
let closeOpenCard: (() => void) | null = null;

interface TriggerProps {
  ref: (node: HTMLElement | null) => void;
  tabIndex: 0;
  role: "button";
  onPointerEnter: (e: React.PointerEvent) => void;
  onPointerLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
}

/**
 * Wire the hover card onto a trigger element. Returns props to spread onto the bubble and the
 * portal node to render alongside it. `enabled === false` returns nothing at all — no handlers, no
 * tab stop, no card (the anonymous / no-id case).
 */
export function useDirectoryCard(opts: {
  userId: string | null;
  displayName: string;
  enabled: boolean;
  /** The caller's own bubble element, re-rendered inside the card at medium size. */
  avatar: ReactNode;
  /** True when the trigger is the signed-in user's own bubble — links to /profile. */
  self?: boolean;
}): { triggerProps: TriggerProps | null; card: ReactNode } {
  const { userId, displayName, enabled, avatar, self } = opts;
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<UserCardData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const triggerRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };

  const close = useCallback(() => {
    clearTimers();
    setOpen(false);
    setPos(null);
    if (closeOpenCard) closeOpenCard = null;
  }, []);

  // Open (and only then fetch — never on mount, so a page of a hundred bubbles issues zero
  // requests until someone actually hovers one).
  const doOpen = useCallback(() => {
    if (!userId) return;
    if (closeOpenCard) closeOpenCard();
    closeOpenCard = close;
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom + GAP_PX }); // refined once the card is measured
    setOpen(true);
    void loadCard(userId).then((card) => {
      setData(card);
      setLoaded(true);
    });
  }, [userId, close]);

  const scheduleClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(close, CLOSE_DELAY_MS);
  }, [close]);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  // Keep the card glued to its bubble: clamp inside the viewport, and flip above when it would
  // overflow the bottom — so it is never clipped by a scrolling table, a dropdown or the sidebar.
  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const w = cardRef.current?.offsetWidth ?? FALLBACK_W;
    const h = cardRef.current?.offsetHeight ?? 0;

    let top = r.bottom + GAP_PX;
    if (h > 0 && top + h > window.innerHeight - EDGE_PX) {
      const above = r.top - GAP_PX - h;
      top = above >= EDGE_PX ? above : Math.max(EDGE_PX, window.innerHeight - EDGE_PX - h);
    }
    const left = Math.max(EDGE_PX, Math.min(r.left, window.innerWidth - EDGE_PX - w));
    setPos({ left, top });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place, data, loaded]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => place();
    // Capture phase so scrolling an inner container repositions too.
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, place]);

  // Escape closes from anywhere (including focus inside the card) and leaves focus on the bubble;
  // a pointer press outside both closes too (matters for a card opened by keyboard focus).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      triggerRef.current?.focus();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (cardRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, close]);

  useEffect(() => clearTimers, []);

  if (!enabled || !userId) return { triggerProps: null, card: null };

  const triggerProps: TriggerProps = {
    ref: (node) => {
      triggerRef.current = node;
    },
    tabIndex: 0,
    role: "button",
    onPointerEnter: (e) => {
      if (e.pointerType !== "mouse") return; // mouse-only: no card on touch or pen (§13.8)
      cancelClose();
      if (openTimer.current) clearTimeout(openTimer.current);
      openTimer.current = setTimeout(doOpen, OPEN_DELAY_MS);
    },
    onPointerLeave: () => {
      if (openTimer.current) clearTimeout(openTimer.current);
      openTimer.current = null;
      if (open) scheduleClose();
    },
    // Focus opens with no delay — hover-intent is a pointer concept.
    onFocus: () => {
      cancelClose();
      doOpen();
    },
    onBlur: scheduleClose, // Tab into the card cancels this via onFocusCapture below
  };

  const card =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={cardRef}
            className="dir-card menu-pop"
            role="dialog"
            aria-label={displayName}
            style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
            onPointerEnter={cancelClose}
            onPointerLeave={scheduleClose}
            onFocusCapture={cancelClose}
            onBlurCapture={scheduleClose}
          >
            <div className="dir-card-head">
              {avatar}
              <span className="dir-card-name">{data?.displayName ?? displayName}</span>
            </div>
            <DirectoryBlock data={data} loaded={loaded} />
            {(!loaded || !data?.scrubbed) && (
              <Link className="dir-card-link" href={self ? "/profile" : `/profile/${userId}`}>
                View profile
              </Link>
            )}
          </div>,
          document.body,
        )
      : null;

  return { triggerProps, card };
}

/** Job title / department / office — each line omitted when empty; all three empty (or a scrubbed
 *  tombstone) collapses to the single muted "No directory information." line. Never an error
 *  state: a slow, failed or 404 response lands in exactly the same place. */
function DirectoryBlock({ data, loaded }: { data: UserCardData | null; loaded: boolean }) {
  if (!loaded) {
    // The card never blocks on the network — it opens with the name and this placeholder.
    return (
      <div className="dir-card-body">
        <span className="dir-card-skeleton" aria-hidden="true" />
        <span className="dir-card-skeleton" aria-hidden="true" />
      </div>
    );
  }

  const lines = [data?.jobTitle, data?.department, data?.officeLocation].filter((v): v is string => !!v && v.trim() !== "");

  return (
    <div className="dir-card-body">
      {lines.length === 0 && <span className="dir-card-empty">No directory information.</span>}
      {lines.map((line) => (
        <span key={line} className="dir-card-line">
          {line}
        </span>
      ))}
      {data?.deactivated && <span className="dir-card-flag">Deactivated</span>}
    </div>
  );
}

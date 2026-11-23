"use client";
// Floating user-search results (INNOBOX_SPEC.md §14.1, §4.3): a portaled, fixed-positioned panel
// anchored to its input so the list is never clipped by, nor pushed under the edge of, the
// surrounding list, card or dialog (`.rows`/`.card` are `overflow: hidden`). Shared by the triage
// page's assign controls, the §4.3 access-list editor and the §43.3 mention list, which hangs under
// a solution's text box or a comment box (§44.2). Follows the input on scroll/resize,
// closes on an outside click, and preventDefaults its own mousedown so a pick never blurs the
// input first. Inside a modal <dialog> (the top layer) the panel is portaled into the dialog
// instead: portaled to <body>, it would sit underneath it.
//
// The panel hangs UNDER its anchor. When it does not fit there and there is more room above — the
// new-comment box is the last thing on a challenge's page — it opens ABOVE the anchor instead, and
// on either side it is never taller than the room it has: its rows then scroll inside it, so every
// result can always be reached.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export function FloatingResults({
  anchorRef,
  onClose,
  children,
  maxWidth = 360,
}: {
  /** The input — or, for the §43.3 mention list, the text box — the panel hangs under. */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  /** The panel is as wide as its anchor, up to this many pixels. */
  maxWidth?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [host, setHost] = useState<Element | null>(null);
  /** The panel's own height, as its rows last laid out — what decides which side it opens on. */
  const [panelHeight, setPanelHeight] = useState(0);

  useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    setHost(el.closest("dialog"));
    const update = () => setRect(el.getBoundingClientRect());
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [anchorRef, onClose]);

  // Measured before paint whenever the rows change (the search narrows) or the anchor moves.
  // `scrollHeight` is the height the rows want, whatever the panel is currently capped to.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel) setPanelHeight(panel.scrollHeight + panel.offsetHeight - panel.clientHeight);
  }, [children, rect]);

  if (!rect) return null;
  const width = Math.min(maxWidth, Math.max(rect.width, 220));
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  // The room on each side of the anchor, keeping the 4 px gap and 8 px from the viewport's edge.
  const roomBelow = window.innerHeight - rect.bottom - 12;
  const roomAbove = rect.top - 12;
  const above = panelHeight > roomBelow && roomAbove > roomBelow;
  const place = above ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 };
  return createPortal(
    <div
      ref={panelRef}
      className="menu-pop user-search-pop"
      data-side={above ? "above" : "below"}
      onMouseDown={(e) => e.preventDefault()}
      style={{ position: "fixed", ...place, left, width, zIndex: 1000, maxHeight: Math.max(96, above ? roomAbove : roomBelow), overflowY: "auto" }}
    >
      {children}
    </div>,
    host ?? document.body,
  );
}

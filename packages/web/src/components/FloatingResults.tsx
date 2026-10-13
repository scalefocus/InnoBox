"use client";
// Floating user-search results (INNOBOX_SPEC.md §14.1, §4.3): a portaled, fixed-positioned panel
// anchored to its input so the list is never clipped by, nor pushed under the edge of, the
// surrounding list, card or dialog (`.rows`/`.card` are `overflow: hidden`). Shared by the triage
// page's assign controls and the §4.3 access-list editor. Follows the input on scroll/resize,
// closes on an outside click, and preventDefaults its own mousedown so a pick never blurs the
// input first. Inside a modal <dialog> (the top layer) the panel is portaled into the dialog
// instead: portaled to <body>, it would sit underneath it.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export function FloatingResults({
  anchorRef,
  onClose,
  children,
}: {
  anchorRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [host, setHost] = useState<Element | null>(null);

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

  if (!rect) return null;
  const width = Math.min(360, Math.max(rect.width, 220));
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  return createPortal(
    <div
      ref={panelRef}
      className="menu-pop user-search-pop"
      onMouseDown={(e) => e.preventDefault()}
      style={{ position: "fixed", top: rect.bottom + 4, left, width, zIndex: 1000 }}
    >
      {children}
    </div>,
    host ?? document.body,
  );
}

"use client";
// The page-wide drop zone and paste router for the §11 upload controls (INNOBOX_SPEC.md §11
// "Drop and paste"). Mounted once per page that carries an upload surface — the challenge form
// and the challenge detail page. Every <AttachmentControl> below it registers as a target while
// it can take files (its own picker is enabled); this provider owns the window listeners:
//
//  - Dragging FILES over the window raises a full-window overlay with one labelled target per
//    available control (one target → the whole overlay). Dropping on a target hands the files to
//    that control's queue; dropping anywhere else attaches nothing.
//  - A file drag is ALWAYS intercepted while this is mounted — with no available control (a lock
//    is held, nothing is editable, a modal is open) there is no overlay and the drop is swallowed,
//    so the browser never opens the file and navigates away from an unsaved form. Text and link
//    drags are left to the browser.
//  - A paste carrying files and no text goes to the control in the focused element's
//    `[data-attach-scope]` (form or card), else the page's only available control; with several
//    available it attaches nothing and says why.
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { dragCarriesFiles, pastedFileName, pasteAttaches, PASTE_AMBIGUOUS_MESSAGE, routePaste } from "@/lib/attachment-intake";

export interface IntakeFile {
  file: File;
  isDirectory: boolean;
}

interface DropTarget {
  label: string;
  enabled: boolean;
  root: HTMLElement | null;
  accept: (files: IntakeFile[]) => void;
}

type Registry = Map<string, DropTarget>;

interface OverlayTarget {
  id: string;
  label: string;
}

const DropZoneContext = createContext<Registry | null>(null);

/** Is a modal <dialog> open? Drops and pastes are swallowed beneath it. */
function modalOpen(): boolean {
  return Array.from(document.querySelectorAll("dialog[open]")).some((d) => {
    try {
      return d.matches(":modal");
    } catch {
      return true;
    }
  });
}

/** Available targets in document order, so the overlay lists them as the page does. */
function availableTargets(registry: Registry): [string, DropTarget][] {
  return [...registry.entries()]
    .filter(([, t]) => t.enabled && t.root?.isConnected)
    .sort(([, a], [, b]) => (a.root!.compareDocumentPosition(b.root!) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
}

/** The dropped entries, with folders flagged (they arrive as Files with no usable bytes). */
function droppedFiles(dt: DataTransfer): IntakeFile[] {
  const out: IntakeFile[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    out.push({ file, isDirectory: entry?.isDirectory === true });
  }
  return out;
}

export function AttachmentDropZone({ children }: { children: React.ReactNode }) {
  const [registry] = useState<Registry>(() => new Map());
  const [overlay, setOverlayState] = useState<OverlayTarget[] | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const depth = useRef(0);
  // The window listeners read the overlay through this mirror, kept in step by setOverlay.
  const overlayRef = useRef<OverlayTarget[] | null>(null);
  const setOverlay = useCallback((next: OverlayTarget[] | null) => {
    overlayRef.current = next;
    setOverlayState(next);
  }, []);

  const close = useCallback(() => {
    depth.current = 0;
    setOverlay(null);
    setHover(null);
  }, [setOverlay]);

  useEffect(() => {
    const targetIdAt = (el: EventTarget | null): string | null => {
      const hit = el instanceof Element ? el.closest<HTMLElement>("[data-drop-target]") : null;
      return hit?.dataset.dropTarget ?? null;
    };

    const onDragEnter = (e: DragEvent) => {
      if (!dragCarriesFiles(e.dataTransfer?.types as readonly string[] | undefined)) return;
      e.preventDefault();
      depth.current += 1;
      if (depth.current === 1) {
        const available = modalOpen() ? [] : availableTargets(registry);
        setOverlay(available.length > 0 ? available.map(([id, t]) => ({ id, label: t.label })) : null);
      }
      setHover(targetIdAt(e.target));
    };
    const onDragOver = (e: DragEvent) => {
      if (!dragCarriesFiles(e.dataTransfer?.types as readonly string[] | undefined)) return;
      e.preventDefault(); // never let the browser open the file
      const onTarget = overlayRef.current !== null && targetIdAt(e.target) !== null;
      if (e.dataTransfer) e.dataTransfer.dropEffect = onTarget ? "copy" : "none";
    };
    const onDragLeave = (e: DragEvent) => {
      if (!dragCarriesFiles(e.dataTransfer?.types as readonly string[] | undefined)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) close();
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer || !dragCarriesFiles(e.dataTransfer.types as readonly string[])) return;
      e.preventDefault();
      const shown = overlayRef.current;
      const id = targetIdAt(e.target);
      close();
      if (!shown || id === null || !shown.some((t) => t.id === id)) return;
      const target = registry.get(id);
      if (target?.enabled) target.accept(droppedFiles(e.dataTransfer));
    };
    // Safety net: pointer moves only arrive once no drag is in progress, so a leftover overlay
    // (a drag cancelled outside the window) clears itself.
    const onPointerMove = () => {
      if (overlayRef.current !== null || depth.current !== 0) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && overlayRef.current !== null) close();
    };
    const onPaste = (e: ClipboardEvent) => {
      const cd = e.clipboardData;
      if (!cd) return;
      const files = Array.from(cd.files);
      if (!pasteAttaches(Array.from(cd.types), files.length) || modalOpen()) return;
      const available = availableTargets(registry);
      if (available.length === 0) return;
      e.preventDefault();
      const scope = document.activeElement?.closest("[data-attach-scope]") ?? null;
      const focused = scope ? (available.find(([, t]) => scope.contains(t.root)) ?? null) : null;
      const route = routePaste(
        focused ? focused[0] : null,
        available.map(([id]) => id),
      );
      if (route.kind === "ambiguous") {
        setToast(PASTE_AMBIGUOUS_MESSAGE);
        window.setTimeout(() => setToast((cur) => (cur === PASTE_AMBIGUOUS_MESSAGE ? null : cur)), 3200);
        return;
      }
      if (route.kind !== "target") return;
      const now = new Date();
      const renamed = files.map((f) => {
        const name = pastedFileName(f.name, f.type, now);
        return { file: name === f.name ? f : new File([f], name, { type: f.type, lastModified: f.lastModified }), isDirectory: false };
      });
      registry.get(route.id)?.accept(renamed);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("paste", onPaste);
    };
  }, [close, registry, setOverlay]);

  const single = overlay !== null && overlay.length === 1;

  return (
    <DropZoneContext.Provider value={registry}>
      {children}
      {overlay && (
        <div className={`drop-overlay${single ? " single" : ""}`} aria-hidden="true" data-testid="drop-overlay">
          {!single && <div className="drop-overlay-title">Drop files to attach</div>}
          {overlay.map((t) => (
            <div key={t.id} className={`drop-target${hover === t.id ? " over" : ""}`} data-drop-target={t.id} data-testid="drop-target">
              <svg className="drop-target-ico" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 16V4M7 9l5-5 5 5" />
                <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
              </svg>
              <span className="drop-target-label">{single ? "Drop files to attach" : t.label}</span>
            </div>
          ))}
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </DropZoneContext.Provider>
  );
}

/** Registers an upload control as a drop/paste target while it can take files. A no-op outside
 *  an <AttachmentDropZone> (the picker still works). Returns whether a drop zone is present. */
export function useAttachmentDropTarget(
  rootRef: React.RefObject<HTMLElement | null>,
  target: { label: string; enabled: boolean; accept: (files: IntakeFile[]) => void },
): boolean {
  const registry = useContext(DropZoneContext);
  const id = useId();
  // Refresh every render so the registry always holds the latest closure and state.
  useEffect(() => {
    registry?.set(id, { ...target, root: rootRef.current });
  });
  useEffect(() => {
    return () => {
      registry?.delete(id);
    };
  }, [registry, id]);
  return registry !== null;
}

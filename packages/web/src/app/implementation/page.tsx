"use client";
// The implementation board (INNOBOX_SPEC.md §46): every accepted solution the viewer can see, as a
// card in the column of its status, from Accepted internally to Implemented. The people who may
// change a solution's status move its card — from its Move to… menu, or by dragging with a mouse —
// and each move is the ordinary status change of §8.2, sent with the two statuses the card showed
// (§46.8). Everything the board shows comes from GET /api/implementation-board, per viewer and
// masked (invariants 2 and 3); `moves` is the server's, and the page never works it out itself.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  BOARD_COPY,
  BOARD_PARAMS,
  IMPLEMENTATION_BOARD_COLUMNS,
  IMPLEMENTATION_BOARD_COLUMN_MAX,
  IMPLEMENTATION_BOARD_PAGE,
  IMPLEMENTATION_BOARD_REFRESH_MS,
  assignedToLabel,
  boardQueryString,
  classifyMoveAnswer,
  columnCapLine,
  hasBoardFilters,
  implementedConfirmText,
  movedAnnouncement,
  retiredTopicOption,
  sanitizeBoardQuery,
  showMoreCount,
  showMoreLabel,
  showingToInclude,
  solutionHypeLabel,
  solutionLikesLabel,
  timeInStageText,
  type BoardColumn,
  type BoardFilters,
} from "@innobox/shared/implementation-board";
import { cachedGet } from "@/lib/ui";
import { reportFeatureUse } from "@/lib/survey-client";
import { shouldRowNavigate } from "@/lib/challenges-view";
import {
  findCard,
  moveCardLocally,
  restoreCard,
  shouldApplyRead,
  type BoardCardData,
  type BoardData,
} from "@/lib/implementation-board-client";
import { useDateFmt } from "@/components/DateFormat";
import { AvatarBubble } from "@/components/AvatarBubble";
import { TeamByline } from "@/components/TeamByline";
import { SOLUTION_STATUS_LABEL, statusPillClass } from "../challenges/status";

const MOBILE_QUERY = "(max-width: 880px)";
const INTERACTIVE = "a, button, input, select, textarea, label, [role='link'], [role='menu'], [tabindex]";
const DRAG_THRESHOLD_PX = 5;

type Showing = Record<BoardColumn, number>;
const INITIAL_SHOWING = Object.fromEntries(IMPLEMENTATION_BOARD_COLUMNS.map((c) => [c, IMPLEMENTATION_BOARD_PAGE])) as Showing;

const columnLabel = (status: BoardColumn): string => SOLUTION_STATUS_LABEL[status] ?? status;
const digits = (n: string): string => n.replace(/\D/g, "");
const cardDomId = (number: string): string => `impl-card-${digits(number)}`;
const columnHeadingId = (status: BoardColumn): string => `impl-col-${status}`;

interface Option {
  id: string;
  name: string;
}

export default function ImplementationPage() {
  // useSearchParams needs a Suspense boundary (the five filters live in the address, §46.5).
  return (
    <Suspense fallback={<p className="muted">{BOARD_COPY.loading}</p>}>
      <ImplementationBoard />
    </Suspense>
  );
}

function ImplementationBoard() {
  const router = useRouter();
  const params = useSearchParams();
  const fmt = useDateFmt();

  // ── Filters: the address is the source of truth; malformed values never reach the API ──
  const { filters, dropped } = useMemo(() => sanitizeBoardQuery(params), [params]);
  const queryString = boardQueryString(filters);
  const replaceAddress = useCallback(
    (next: BoardFilters) => {
      const out = new URLSearchParams(window.location.search);
      for (const name of Object.values(BOARD_PARAMS)) out.delete(name);
      for (const [k, v] of new URLSearchParams(boardQueryString(next))) out.set(k, v);
      const qs = out.toString();
      router.replace(qs ? `/implementation?${qs}` : "/implementation", { scroll: false });
    },
    [router],
  );
  useEffect(() => {
    if (dropped.length > 0) replaceAddress(filters);
  }, [dropped, filters, replaceAddress]);

  const [impactAreas, setImpactAreas] = useState<Option[] | null>(null);
  const [topics, setTopics] = useState<Option[] | null>(null);
  const [retiredTopic, setRetiredTopic] = useState<Option | null>(null);
  useEffect(() => {
    cachedGet<{ impactAreas: Option[] }>("/api/impact-areas")
      .then((j) => setImpactAreas(j.impactAreas ?? []))
      .catch(() => setImpactAreas([]));
    cachedGet<{ topics: Option[] }>("/api/topics")
      .then((j) => setTopics(j.topics ?? []))
      .catch(() => setTopics([]));
  }, []);

  // §46.5: an impact area not among the active ones is dropped.
  useEffect(() => {
    if (impactAreas && filters.impactAreaId && !impactAreas.some((a) => a.id === filters.impactAreaId)) {
      replaceAddress({ ...filters, impactAreaId: undefined });
    }
  }, [impactAreas, filters, replaceAddress]);

  // §46.5: a topic not among the active ones is looked up — a retired one stays and is shown as an
  // extra, selected option; an unknown one (404) is dropped.
  useEffect(() => {
    if (!topics || !filters.topicId || topics.some((t) => t.id === filters.topicId)) {
      setRetiredTopic(null);
      return;
    }
    let live = true;
    const id = filters.topicId;
    fetch(`/api/topics/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } })
      .then(async (res) => {
        if (!live) return;
        if (res.status === 404 || res.status === 400) {
          replaceAddress({ ...filters, topicId: undefined });
          return;
        }
        if (!res.ok) return;
        const json = (await res.json()) as { topic: Option };
        if (live) setRetiredTopic({ id: json.topic.id, name: json.topic.name });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [topics, filters, replaceAddress]);

  // ── The board and the live refresh (§46.8) ──
  const [board, setBoard] = useState<BoardData | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reading, setReading] = useState(false);
  /** The query the cards on show were read with — a filter change dims them until its read lands. */
  const [appliedQuery, setAppliedQuery] = useState<string | null>(null);
  const [showing, setShowing] = useState<Showing>(INITIAL_SHOWING);
  const [openSections, setOpenSections] = useState<Record<BoardColumn, boolean> | null>(null);
  const [mobile, setMobile] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [inFlight, setInFlight] = useState<Set<string>>(new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ number: string; moves: BoardColumn[] } | null>(null);
  const [overColumn, setOverColumn] = useState<BoardColumn | null>(null);
  /** §46.5: a namespace the viewer chose stays chosen, with its slug, after its last card leaves. */
  const [keptNamespace, setKeptNamespace] = useState<{ id: string; slug: string } | null>(null);
  const [now, setNow] = useState(() => new Date());

  const readSeq = useRef(0);
  const moveEpoch = useRef(0);
  const movesInFlight = useRef(0);
  const interacting = useRef(false);
  const pendingRead = useRef(false);
  const stopped = useRef(false);
  const checkedQuery = useRef<string | null>(null);
  const pendingFocus = useRef<{ number: string; target: "title" | "menu" | "heading"; column?: BoardColumn } | null>(null);
  const pendingScroll = useRef<string | null>(null);
  const queryRef = useRef(queryString);
  const appliedQueryRef = useRef<string | null>(null);
  // Kept in step after each render, before the read effect below runs.
  useEffect(() => {
    queryRef.current = queryString;
    appliedQueryRef.current = appliedQuery;
  }, [queryString, appliedQuery]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((cur) => (cur === message ? null : cur)), 4000);
  }, []);

  const read = useCallback(async () => {
    if (stopped.current) return;
    if (movesInFlight.current > 0 || interacting.current) {
      pendingRead.current = true;
      return;
    }
    pendingRead.current = false;
    const seq = ++readSeq.current;
    const epochAtSend = moveEpoch.current;
    const qs = queryRef.current;
    setReading(true);
    try {
      const res = await fetch(`/api/implementation-board${qs ? `?${qs}` : ""}`, { headers: { accept: "application/json" }, cache: "no-store" });
      if (res.status === 401) {
        stopped.current = true;
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as BoardData;
      const apply = shouldApplyRead({
        readSeq: seq,
        latestReadSeq: readSeq.current,
        moveEpochAtSend: epochAtSend,
        moveEpochNow: moveEpoch.current,
        movesInFlight: movesInFlight.current,
        interacting: interacting.current,
      });
      if (!apply) {
        if (seq === readSeq.current) pendingRead.current = true;
        return;
      }
      setBoard(json);
      setAppliedQuery(qs);
      setNow(new Date());
      setLoadFailed(false);
      setOpenSections((cur) => cur ?? (Object.fromEntries(json.columns.map((c) => [c.status, c.total > 0])) as Record<BoardColumn, boolean>));
    } catch {
      // A failed read keeps the cards and tries again at the next tick; after a filter change the
      // cards stay dimmed and a toast says so (§46.3).
      if (seq === readSeq.current) {
        setLoadFailed(true);
        if (appliedQueryRef.current !== null && appliedQueryRef.current !== qs) showToast(BOARD_COPY.loadFailedToast);
      }
    } finally {
      if (seq === readSeq.current) setReading(false);
    }
  }, [showToast]);

  const endInteraction = useCallback(() => {
    interacting.current = false;
    if (pendingRead.current && movesInFlight.current === 0) void read();
  }, [read]);

  // A new query (a filter change) reads at once; the cards on show stay, dimmed, until it lands.
  useEffect(() => {
    void read();
  }, [queryString, read]);

  // §46.5: after the first read for an address, a namespace the answer does not list is dropped —
  // once; a later re-read never removes a filter.
  useEffect(() => {
    if (!board || reading) return;
    if (checkedQuery.current === queryString) return;
    checkedQuery.current = queryString;
    if (filters.namespaceId) {
      const listed = board.namespaces.find((n) => n.id === filters.namespaceId);
      if (!listed && keptNamespace?.id !== filters.namespaceId) replaceAddress({ ...filters, namespaceId: undefined });
    }
  }, [board, reading, queryString, filters, keptNamespace, replaceAddress]);

  // Every 30 seconds while the tab is visible; at once when it becomes visible again.
  useEffect(() => {
    const tick = window.setInterval(() => {
      if (document.visibilityState === "visible") void read();
    }, IMPLEMENTATION_BOARD_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [read]);

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const update = () => setMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Focus and scroll after the board re-renders (§46.7).
  useLayoutEffect(() => {
    const scroll = pendingScroll.current;
    if (scroll) {
      const el = document.getElementById(cardDomId(scroll));
      if (el) {
        el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        pendingScroll.current = null;
      }
    }
    const focus = pendingFocus.current;
    if (!focus) return;
    if (focus.target === "heading" && focus.column) {
      document.getElementById(columnHeadingId(focus.column))?.focus();
      pendingFocus.current = null;
      return;
    }
    const cardEl = document.getElementById(cardDomId(focus.number));
    // §46.7 On a refusal: the card's Move to… button once it is back, its title when it has no moves
    // left, and the heading of the column it was in when the board no longer holds it.
    if (!cardEl) {
      if (focus.target === "menu" && focus.column && !reading) {
        document.getElementById(columnHeadingId(focus.column))?.focus();
        pendingFocus.current = null;
      }
      return;
    }
    const el =
      focus.target === "menu"
        ? (cardEl.querySelector<HTMLElement>(".impl-move-btn") ?? (reading ? null : cardEl.querySelector<HTMLElement>(".impl-card-title")))
        : cardEl.querySelector<HTMLElement>(".impl-card-title");
    if (el) {
      el.focus();
      pendingFocus.current = null;
    }
  });

  // After a read lands, a moved card whose title holds focus hands it on to its Move to… button.
  useEffect(() => {
    if (!board) return;
    const active = document.activeElement;
    const cardEl = active?.closest?.(".impl-card");
    if (!cardEl || !active?.classList.contains("impl-card-title")) return;
    const number = (cardEl as HTMLElement).dataset.number;
    const c = number ? findCard(board, number) : undefined;
    if (c && c.moves.length > 0 && !inFlight.has(c.number)) {
      cardEl.querySelector<HTMLElement>(".impl-move-btn")?.focus();
    }
  }, [board, inFlight]);

  // ── Moving a card (§46.7) ──
  const moveCard = useCallback(
    async (number: string, to: BoardColumn) => {
      const current = findCard(board, number);
      if (!current || inFlight.has(number) || !current.moves.includes(to)) return;
      if (to === "implemented") {
        // window.confirm is OS-drawn and blocking (§2.2) — the board is quiet while it is open.
        interacting.current = true;
        const ok = window.confirm(implementedConfirmText(current.number, current.challengeNumber, current.challengeStatus === "solved"));
        endInteraction();
        if (!ok) return;
      }
      const optimistic = to !== "implemented";
      let original = current;
      let beyondCap = false;
      if (optimistic) {
        const local = moveCardLocally(board!, number, to, new Date());
        if (!local) return;
        original = local.original;
        beyondCap = local.beyondCap;
        setBoard(local.board);
        if (!beyondCap) {
          setShowing((s) => ({ ...s, [to]: showingToInclude(local.index, s[to]) }));
          pendingScroll.current = number;
        }
        if (mobile) setOpenSections((s) => (s ? { ...s, [to]: true } : s));
      }
      setInFlight((s) => new Set(s).add(number));
      movesInFlight.current += 1;
      moveEpoch.current += 1;
      let reread = false;
      try {
        const res = await fetch(`/api/solutions/${digits(number)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: to, baseStatus: original.status, baseChallengeStatus: original.challengeStatus }),
        });
        if (res.ok) {
          if (!optimistic) {
            const local = moveCardLocally(board!, number, to, new Date());
            if (local) {
              beyondCap = local.beyondCap;
              setBoard(local.board);
              if (!beyondCap) {
                setShowing((s) => ({ ...s, [to]: showingToInclude(local.index, s[to]) }));
                pendingScroll.current = number;
              }
              if (mobile) setOpenSections((s) => (s ? { ...s, [to]: true } : s));
            }
          }
          setAnnouncement(movedAnnouncement(number, columnLabel(to), beyondCap));
          pendingFocus.current = beyondCap ? { number, target: "heading", column: to } : { number, target: "title" };
          // §13.10: an enforced move is the `review` first use; an override reports nothing.
          if (original.moveMode === "enforced") reportFeatureUse("review");
          reread = true;
        } else {
          const outcome = classifyMoveAnswer(res.status);
          if (optimistic) setBoard((b) => (b ? restoreCard(b, original, to) : b));
          pendingFocus.current = { number, target: "menu", column: original.status };
          if (outcome.refusal === "signed_out") stopped.current = true;
          else
            showToast(
              outcome.refusal === "changed" ? BOARD_COPY.changedToast : outcome.refusal === "no_longer_yours" ? BOARD_COPY.noLongerYoursToast : BOARD_COPY.notSavedToast,
            );
          reread = outcome.reread;
        }
      } catch {
        if (optimistic) setBoard((b) => (b ? restoreCard(b, original, to) : b));
        pendingFocus.current = { number, target: "menu", column: original.status };
        showToast(BOARD_COPY.notSavedToast);
      } finally {
        movesInFlight.current -= 1;
        moveEpoch.current += 1;
        setInFlight((s) => {
          const next = new Set(s);
          next.delete(number);
          return next;
        });
        if (reread) pendingRead.current = true;
        if (movesInFlight.current === 0 && pendingRead.current && !interacting.current) void read();
      }
    },
    [board, inFlight, mobile, endInteraction, read, showToast],
  );

  // ── Dragging, for a mouse in the five-column layout only (§46.7) ──
  const dragStart = useRef<{ x: number; y: number; number: string; moves: BoardColumn[]; started: boolean } | null>(null);
  const suppressClick = useRef(false);
  const onCardPointerDown = (e: ReactPointerEvent<HTMLElement>, c: BoardCardData) => {
    if (mobile || e.pointerType !== "mouse" || e.button !== 0) return;
    if (c.moves.length === 0 || inFlight.has(c.number)) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(INTERACTIVE)) return; // never from the title, a chip, a bubble or the menu button
    dragStart.current = { x: e.clientX, y: e.clientY, number: c.number, moves: c.moves, started: false };
  };
  useEffect(() => {
    const columnAt = (x: number, y: number): BoardColumn | null => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-column]");
      return (el?.dataset.column as BoardColumn | undefined) ?? null;
    };
    const onMove = (e: PointerEvent) => {
      const d = dragStart.current;
      if (!d) return;
      if (!d.started) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD_PX) return;
        d.started = true;
        interacting.current = true;
        setDragging({ number: d.number, moves: d.moves });
        window.getSelection()?.removeAllRanges();
      }
      setOverColumn(columnAt(e.clientX, e.clientY));
    };
    const finish = (drop: boolean, e?: PointerEvent) => {
      const d = dragStart.current;
      dragStart.current = null;
      if (!d?.started) return;
      suppressClick.current = true;
      window.setTimeout(() => (suppressClick.current = false), 0);
      const over = drop && e ? columnAt(e.clientX, e.clientY) : null;
      setDragging(null);
      setOverColumn(null);
      endInteraction();
      // A drop on a target does exactly what the menu item does; anything else puts the card back.
      if (over && d.moves.includes(over)) void moveCard(d.number, over);
    };
    const onUp = (e: PointerEvent) => finish(true, e);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [moveCard, endInteraction]);

  const openCard = (e: ReactMouseEvent<HTMLElement>, href: string) => {
    if (suppressClick.current) return;
    const target = e.target instanceof Element ? e.target : null;
    const go = shouldRowNavigate({
      onInteractive: !!target?.closest(INTERACTIVE),
      selectionText: window.getSelection()?.toString() ?? "",
      button: e.button,
      modifier: e.metaKey || e.ctrlKey || e.shiftKey || e.altKey,
    });
    if (go) router.push(href);
  };

  // ── Rendering ──
  const setFilter = (patch: Partial<BoardFilters>) => {
    const next = { ...filters, ...patch };
    if (patch.namespaceId) {
      const slug = board?.namespaces.find((n) => n.id === patch.namespaceId)?.slug;
      setKeptNamespace(slug ? { id: patch.namespaceId, slug } : null);
    }
    replaceAddress(next);
  };
  const namespaceOptions = useMemo(() => {
    const listed = board?.namespaces ?? [];
    if (filters.namespaceId && !listed.some((n) => n.id === filters.namespaceId) && keptNamespace?.id === filters.namespaceId) {
      return [...listed, keptNamespace];
    }
    return listed;
  }, [board, filters.namespaceId, keptNamespace]);

  const filtered = hasBoardFilters(filters);
  const totalCards = board ? board.columns.reduce((n, c) => n + c.total, 0) : 0;
  const dimmed = board !== null && (reading || appliedQuery !== queryString);
  const implementedNote = (
    <p className="impl-note muted">
      {BOARD_COPY.implementedNote} <Link href="/challenges?tab=completed">{BOARD_COPY.implementedNoteLink}</Link>.
    </p>
  );

  return (
    <div className="impl-page">
      <div className="page-head reveal">
        <div className="eyebrow">Discover</div>
        <h1 className="page-title">{BOARD_COPY.title}</h1>
        <p className="page-sub">{BOARD_COPY.subtitle}</p>
      </div>

      <div className="impl-filters" role="group" aria-label="Filters">
        <select
          className="field"
          aria-label="Namespace"
          value={filters.namespaceId ?? ""}
          onChange={(e) => setFilter({ namespaceId: e.target.value || undefined })}
        >
          <option value="">{BOARD_COPY.allNamespaces}</option>
          {namespaceOptions.map((n) => (
            <option key={n.id} value={n.id}>
              /{n.slug}
            </option>
          ))}
        </select>
        <select
          className="field"
          aria-label="Impact area"
          value={filters.impactAreaId ?? ""}
          onChange={(e) => setFilter({ impactAreaId: e.target.value || undefined })}
        >
          <option value="">{BOARD_COPY.allImpactAreas}</option>
          {(impactAreas ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {((topics && topics.length > 0) || retiredTopic) && (
          <select className="field" aria-label="Topic" value={filters.topicId ?? ""} onChange={(e) => setFilter({ topicId: e.target.value || undefined })}>
            <option value="">{BOARD_COPY.allTopics}</option>
            {(topics ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
            {retiredTopic && filters.topicId === retiredTopic.id && <option value={retiredTopic.id}>{retiredTopicOption(retiredTopic.name)}</option>}
          </select>
        )}
        <span className="sort-toggle">
          <button type="button" className={filters.involving ? "sort-opt sort-on" : "sort-opt"} aria-pressed={filters.involving} onClick={() => setFilter({ involving: !filters.involving })}>
            {BOARD_COPY.involvingMe}
          </button>
        </span>
        <span className="sort-toggle">
          <button type="button" className={filters.following ? "sort-opt sort-on" : "sort-opt"} aria-pressed={filters.following} onClick={() => setFilter({ following: !filters.following })}>
            {BOARD_COPY.following}
          </button>
        </span>
        {filtered && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => replaceAddress({ involving: false, following: false })}>
            {BOARD_COPY.clearFilters}
          </button>
        )}
      </div>

      {board === null && !loadFailed && <p className="muted">{BOARD_COPY.loading}</p>}
      {board === null && loadFailed && (
        <div className="card card-pad empty reveal">
          <p className="muted" style={{ margin: 0 }}>
            {BOARD_COPY.loadFailed}
          </p>
          <p style={{ margin: "10px 0 0" }}>
            <button type="button" className="btn btn-sm" onClick={() => void read()}>
              {BOARD_COPY.tryAgain}
            </button>
          </p>
        </div>
      )}
      {board !== null && totalCards === 0 && !filtered && (
        <div className="card card-pad empty reveal">
          <p className="muted" style={{ margin: 0 }}>
            {BOARD_COPY.emptyBoard}
          </p>
          {implementedNote}
        </div>
      )}
      {board !== null && totalCards === 0 && filtered && (
        <div className="card card-pad empty reveal">
          <p className="muted" style={{ margin: 0 }}>
            {BOARD_COPY.noMatch}
          </p>
          <p style={{ margin: "10px 0 0" }}>
            <button type="button" className="btn btn-sm" onClick={() => replaceAddress({ involving: false, following: false })}>
              {BOARD_COPY.clearFilters}
            </button>
          </p>
        </div>
      )}
      {board !== null && totalCards > 0 && (
        <div className={`impl-board${mobile ? " is-stacked" : ""}${dimmed ? " is-dimmed" : ""}${dragging ? " is-dragging" : ""}`} aria-busy={dimmed}>
          {board.columns.map((col) => {
            const open = !mobile || (openSections?.[col.status] ?? col.total > 0);
            const count = Math.min(showing[col.status], col.cards.length);
            const more = showMoreCount(col.cards.length, count);
            const isTarget = dragging?.moves.includes(col.status) ?? false;
            const colClass = `impl-col${dragging ? (isTarget ? " is-target" : " is-dimmed-target") : ""}${overColumn === col.status && isTarget ? " is-over" : ""}`;
            const heading = (
              <>
                <span className={statusPillClass(col.status)}>{columnLabel(col.status)}</span>
                <span className="impl-col-count mono"> · {col.total}</span>
              </>
            );
            return (
              <section key={col.status} className={colClass} data-column={col.status} aria-labelledby={columnHeadingId(col.status)}>
                {mobile ? (
                  <button
                    type="button"
                    id={columnHeadingId(col.status)}
                    className="impl-col-head impl-col-toggle"
                    aria-expanded={open}
                    aria-controls={`${columnHeadingId(col.status)}-body`}
                    onClick={() => setOpenSections((s) => ({ ...(s ?? ({} as Record<BoardColumn, boolean>)), [col.status]: !open }))}
                  >
                    {heading}
                  </button>
                ) : (
                  <h2 id={columnHeadingId(col.status)} className="impl-col-head" tabIndex={-1}>
                    {heading}
                  </h2>
                )}
                {col.status === "implemented" && mobile && implementedNote}
                {open && (
                  <div className="impl-col-body" id={`${columnHeadingId(col.status)}-body`}>
                    {col.cards.length === 0 && <p className="impl-empty muted">{BOARD_COPY.emptyColumn}</p>}
                    {col.cards.slice(0, count).map((c) => (
                      <BoardCard
                        key={c.number}
                        card={c}
                        now={now}
                        fmt={fmt}
                        busy={inFlight.has(c.number)}
                        dragging={dragging?.number === c.number}
                        menuOpen={menuFor === c.number}
                        onOpen={openCard}
                        onPointerDown={onCardPointerDown}
                        onTopic={(id) => setFilter({ topicId: id })}
                        onMenu={(open) => {
                          if (open) {
                            interacting.current = true;
                            setMenuFor(c.number);
                          } else {
                            setMenuFor(null);
                            endInteraction();
                          }
                        }}
                        onMove={(to) => {
                          setMenuFor(null);
                          endInteraction();
                          void moveCard(c.number, to);
                        }}
                      />
                    ))}
                    {more > 0 && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm impl-more"
                        onClick={() => setShowing((s) => ({ ...s, [col.status]: count + IMPLEMENTATION_BOARD_PAGE }))}
                      >
                        {showMoreLabel(more)}
                      </button>
                    )}
                    {more === 0 && col.total > col.cards.length && col.cards.length >= IMPLEMENTATION_BOARD_COLUMN_MAX && (
                      <p className="impl-cap muted">{columnCapLine(col.total)}</p>
                    )}
                    {col.status === "implemented" && !mobile && implementedNote}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function BoardCard({
  card,
  now,
  fmt,
  busy,
  dragging,
  menuOpen,
  onOpen,
  onPointerDown,
  onTopic,
  onMenu,
  onMove,
}: {
  card: BoardCardData;
  now: Date;
  fmt: { date: (iso: string) => string; dateTime: (iso: string) => string };
  busy: boolean;
  dragging: boolean;
  menuOpen: boolean;
  onOpen: (e: ReactMouseEvent<HTMLElement>, href: string) => void;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>, c: BoardCardData) => void;
  onTopic: (id: string) => void;
  onMenu: (open: boolean) => void;
  onMove: (to: BoardColumn) => void;
}) {
  const href = `/challenges/${digits(card.challengeNumber)}#${card.number}`;
  const movable = card.moves.length > 0;
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <article
      id={cardDomId(card.number)}
      data-number={card.number}
      className={`impl-card card${movable && !busy ? " is-movable" : ""}${dragging ? " is-dragged" : ""}${busy ? " is-busy" : ""}`}
      onClick={(e) => onOpen(e, href)}
      onPointerDown={(e) => onPointerDown(e, card)}
    >
      <Link className="impl-card-title" href={href} title={card.challengeTitle}>
        {card.challengeTitle}
      </Link>
      <div className="impl-card-ids mono muted">
        {card.number} · {card.challengeNumber} · /{card.namespaceSlug}
      </div>
      <div className="impl-card-chips">
        <span className="chip">{card.impactAreaName}</span>
        {card.topics.map((t) => (
          <button
            key={t.id}
            type="button"
            className={t.active ? "chip topic-chip" : "chip topic-chip is-retired"}
            title={t.active ? `Filter by ${t.name}` : "Retired topic"}
            onClick={(e) => {
              e.stopPropagation();
              onTopic(t.id);
            }}
          >
            {t.name}
          </button>
        ))}
      </div>
      <div className="impl-card-stage muted" title={fmt.dateTime(card.statusChangedAt)}>
        {card.status === "implemented" ? `Implemented on ${fmt.date(card.statusChangedAt)}` : timeInStageText(card.statusChangedAt, now)}
      </div>
      <div className="impl-card-foot">
        <TeamByline authors={card.authors.length > 0 ? card.authors : [card.author]} className="impl-card-author" />
        <span className="impl-card-meta">
          {card.assigneeId ? (
            <span className="impl-assignee" aria-label={assignedToLabel(card.assigneeScrubbed ? "Deleted User" : (card.assigneeDisplayName ?? ""))}>
              <AvatarBubble
                userId={card.assigneeId}
                displayName={card.assigneeDisplayName ?? ""}
                deactivated={card.assigneeActive === false}
                scrubbed={card.assigneeScrubbed === true}
                title={assignedToLabel(card.assigneeScrubbed ? "Deleted User" : (card.assigneeDisplayName ?? ""))}
              />
            </span>
          ) : (
            <span className="muted impl-unassigned">{BOARD_COPY.unassigned}</span>
          )}
          <span className="impl-stat" aria-label={solutionLikesLabel(card.likeCount)} title={solutionLikesLabel(card.likeCount)}>
            ♥ {card.likeCount}
          </span>
          {card.hype !== undefined && (
            <span className="impl-stat" aria-label={solutionHypeLabel(card.hype)} title={solutionHypeLabel(card.hype)}>
              🔥 {card.hype}
            </span>
          )}
        </span>
      </div>
      {movable && (
        <div className="impl-card-actions">
          <button
            ref={btnRef}
            type="button"
            className="btn btn-sm impl-move-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              if (busy) return;
              onMenu(!menuOpen);
            }}
          >
            {BOARD_COPY.moveTo}
          </button>
          {menuOpen && <MoveMenu anchor={btnRef} moves={card.moves} onPick={onMove} onClose={() => onMenu(false)} />}
        </div>
      )}
    </article>
  );
}

/** §46.7: the Move to… list — a `.menu-pop` popover in an overlay layer, so a column never clips it. */
function MoveMenu({
  anchor,
  moves,
  onPick,
  onClose,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  moves: BoardColumn[];
  onPick: (to: BoardColumn) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 6, left: Math.min(rect.left, window.innerWidth - 220) });
  }, [anchor]);
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", onScroll);
    };
  }, [anchor, onClose]);
  const close = () => {
    onClose();
    anchor.current?.focus();
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      close();
    }
  };
  if (!pos) return null;
  return createPortal(
    <div
      ref={menuRef}
      className="impl-move-menu menu-pop"
      role="menu"
      style={{ top: pos.top, left: pos.left }}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      {moves.map((to) => (
        <button
          key={to}
          type="button"
          role="menuitem"
          className="user-menu-item"
          onClick={() => {
            anchor.current?.focus();
            onPick(to);
          }}
        >
          {columnLabel(to)}
        </button>
      ))}
    </div>,
    document.body,
  );
}

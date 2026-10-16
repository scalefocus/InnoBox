"use client";
// The "Currently online" panel body (INNOBOX_SPEC.md §14.5) — platform admin only; the card
// wrapper and the gate live in admin/page.tsx.
//
// Deliberately NOT auto-refreshing (§14.5): a 5-minute window that silently ages for half an
// hour is worse than a stale one you can see, so the panel is an explicit snapshot with a
// "Refresh" button and an "as of" stamp. Nothing here polls.
//
// The active-users chart fetches the whole series once and zooms on the client: the
// 7d / 30d / 90d / All buttons are presets that move the zoom window, never a refetch (§14.5).
//
// There is no "Reach out" action, unlike the sibling app this panel is modelled on: the panel
// answers *who is around*, and InnoBox has no direct-message channel to hand off to.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AvatarBubble } from "@/components/AvatarBubble";
import { useDateFmt } from "@/components/DateFormat";
import { EChart } from "@/components/EChart";
import type { ChartEnv } from "@/lib/charts/chart-env";
import {
  applyManualZoom,
  buildPresenceOption,
  presetWindow,
  seriesExtent,
  type PresenceChartPoint,
  type ZoomWindow,
} from "@/lib/charts/presence-chart";
import {
  DEFAULT_PRESENCE_RANGE,
  DEFAULT_PRESENCE_WINDOW,
  PRESENCE_RANGES,
  PRESENCE_WINDOWS,
  PRESENCE_LIST_CAP,
  parsePresenceWindow,
  relativeActive,
  windowPhrase,
  type PresenceRange,
  type PresenceWindow,
} from "@/lib/presence";

const WINDOW_STORAGE_KEY = "innobox:presence-window";

interface OnlineUser {
  id: string;
  displayName: string;
  email: string | null;
  active: boolean;
  lastSeenAt: string;
  location: string | null;
}

interface PresenceSummary {
  asOf: string;
  window: PresenceWindow;
  dau: number;
  wau: number;
  mau: number;
  total: number;
  users: OnlineUser[];
}

interface PresenceHistory {
  range: PresenceRange;
  points: PresenceChartPoint[];
  enoughHistory: boolean;
}

/** The window survives reloads per browser, like the console's card-collapse state (§14.5). */
function loadWindow(): PresenceWindow {
  if (typeof window === "undefined") return DEFAULT_PRESENCE_WINDOW;
  try {
    return parsePresenceWindow(window.localStorage.getItem(WINDOW_STORAGE_KEY));
  } catch {
    return DEFAULT_PRESENCE_WINDOW;
  }
}

export function CurrentlyOnline({ onTotal }: { onTotal?: (total: number | null) => void }) {
  const [window_, setWindow] = useState<PresenceWindow>(loadWindow);
  // The pressed preset — null once the admin zooms by hand. `zoomRequest` changes only on a
  // click, so un-pressing never rebuilds the chart mid-drag.
  const [pressed, setPressed] = useState<PresenceRange | null>(DEFAULT_PRESENCE_RANGE);
  const [zoomRequest, setZoomRequest] = useState(0);
  const pressedRef = useRef<PresenceRange | null>(DEFAULT_PRESENCE_RANGE);
  const zoomWindow = useRef<ZoomWindow | null>(null);
  const [summary, setSummary] = useState<PresenceSummary | null>(null);
  const [history, setHistory] = useState<PresenceHistory | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fmt = useDateFmt();

  // The relative pills ("48m ago") are computed against the moment the snapshot was taken,
  // not a live clock — with no auto-refresh, ticking them would imply data that is refreshing.
  const asOfMs = summary ? Date.parse(summary.asOf) : 0;

  // Latest-callback ref, synced in an effect (not during render) so `load` stays stable.
  const reportTotal = useRef(onTotal);
  useEffect(() => {
    reportTotal.current = onTotal;
  }, [onTotal]);

  const loadSummary = useCallback(async (w: PresenceWindow) => {
    const res = await fetch(`/api/admin/presence?window=${w}`, { cache: "no-store", headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("Could not load presence");
    const summaryJson = (await res.json()) as PresenceSummary;
    setSummary(summaryJson);
    reportTotal.current?.(summaryJson.total);
  }, []);

  // The whole series, once: the presets zoom over it on the client.
  const loadHistory = useCallback(async () => {
    const res = await fetch("/api/admin/presence/history?range=all", { cache: "no-store", headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("Could not load presence history");
    setHistory((await res.json()) as PresenceHistory);
  }, []);

  // The list and the series load independently; "busy" holds until both have settled.
  const pending = useRef(0);
  const run = useCallback(async (work: () => Promise<unknown>) => {
    pending.current += 1;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch {
      setError("Could not load who is online.");
    } finally {
      pending.current -= 1;
      if (pending.current === 0) setBusy(false);
    }
  }, []);

  // The window drives the list only; the chart series does not depend on it.
  useEffect(() => {
    void run(() => loadSummary(window_));
  }, [run, loadSummary, window_]);

  useEffect(() => {
    void run(loadHistory);
  }, [run, loadHistory]);

  const refresh = () => void run(() => Promise.all([loadSummary(window_), loadHistory()]));

  const choosePreset = (r: PresenceRange) => {
    pressedRef.current = r;
    setPressed(r);
    setZoomRequest((n) => n + 1);
  };

  const points = history?.points;
  // A pressed preset is re-applied to fresh data (Refresh adds today); a hand-picked window is
  // kept as it is. The refs are read at build time, so un-pressing alone never rebuilds.
  const buildChart = useCallback(
    (env: ChartEnv) => {
      const series = points ?? [];
      const preset = pressedRef.current;
      const zoom = preset
        ? presetWindow(series, preset)
        : (zoomWindow.current ?? presetWindow(series, DEFAULT_PRESENCE_RANGE));
      zoomWindow.current = zoom;
      return buildPresenceOption({ points: series, window: zoom, style: fmt.style, env });
    },
    // zoomRequest is not read inside: it is the signal that a preset click must rebuild even
    // when the series is unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [points, fmt.style, zoomRequest],
  );

  const onDataZoom = useCallback(
    (params: unknown) => {
      const extent = seriesExtent(points ?? []);
      if (!extent) return;
      const next = applyManualZoom(params, extent, zoomWindow.current);
      zoomWindow.current = next.window;
      pressedRef.current = next.pressed;
      setPressed(next.pressed);
    },
    [points],
  );

  useEffect(() => {
    try {
      localStorage.setItem(WINDOW_STORAGE_KEY, window_);
    } catch {
      /* private mode / quota — the choice just won't persist */
    }
  }, [window_]);

  // Client-side filter over the fetched page: the set is capped at 200, so there is nothing
  // to gain from a round trip per keystroke.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !summary) return summary?.users ?? [];
    return summary.users.filter(
      (u) => u.displayName.toLowerCase().includes(q) || (u.email ?? "").toLowerCase().includes(q),
    );
  }, [query, summary]);

  const truncated = summary ? summary.total > summary.users.length : false;

  return (
    <>
      <div className="presence-head">
        <div className="stat-label" style={{ marginTop: 0 }}>
          Active users
        </div>
        <div className="presence-toggles">
          {PRESENCE_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              className={pressed === r ? "btn btn-sm btn-primary" : "btn btn-sm"}
              onClick={() => choosePreset(r)}
              aria-pressed={pressed === r}
            >
              {r === "all" ? "All" : r}
            </button>
          ))}
        </div>
      </div>

      <ActiveUsersChart history={history} build={buildChart} onDataZoom={onDataZoom} />

      <div className="stat-row" style={{ marginTop: 16 }}>
        <div className="stat">
          <div className="stat-num">{summary?.dau ?? "–"}</div>
          <div className="stat-label">DAU · last 24h</div>
        </div>
        <div className="stat">
          <div className="stat-num">{summary?.wau ?? "–"}</div>
          <div className="stat-label">WAU · last 7d</div>
        </div>
        <div className="stat">
          <div className="stat-num">{summary?.mau ?? "–"}</div>
          <div className="stat-label">MAU · last 30d</div>
        </div>
      </div>

      <div className="presence-head" style={{ marginTop: 22 }}>
        <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
          Users active within {windowPhrase(window_)}.
        </p>
        <div className="presence-toggles">
          {PRESENCE_WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={window_ === w ? "btn btn-sm btn-primary" : "btn btn-sm"}
              onClick={() => setWindow(w)}
              aria-pressed={window_ === w}
            >
              {w}
            </button>
          ))}
        </div>
      </div>

      <input
        className="field"
        style={{ width: "100%", marginBottom: 10 }}
        placeholder="Search online users by name or email…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search online users"
      />

      {error && <p className="muted">{error}</p>}
      {!error && !summary && <p className="muted">Loading…</p>}
      {!error && summary && visible.length === 0 && (
        <p className="muted">
          {query.trim() ? "No online user matches that search." : `Nobody has been active within ${windowPhrase(window_)}.`}
        </p>
      )}

      {visible.length > 0 && (
        <div className="rows">
          {visible.map((u) => (
            <div className="row" key={u.id}>
              <AvatarBubble size="sm" userId={u.id} displayName={u.displayName} deactivated={!u.active} />
              <span className="grow">
                <span className="ttl">{u.displayName}</span>
                {u.email && <div className="sub mono">{u.email}</div>}
              </span>
              {!u.active && <span className="pill pill-muted">Deactivated</span>}
              {u.location && <span className="presence-where muted">{u.location}</span>}
              <span className="chip">active {relativeActive(u.lastSeenAt, asOfMs)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="presence-foot">
        <span className="muted">
          {summary && truncated && (
            <>
              Showing {summary.users.length} of {summary.total} · capped at {PRESENCE_LIST_CAP} ·{" "}
            </>
          )}
          {summary && <>as of {fmt.time(summary.asOf)}</>}
        </span>
        <button type="button" className="btn btn-sm" onClick={refresh} disabled={busy}>
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* §14.5: covert monitoring is not on the table — the panel says what it records. */}
      <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
        Presence is recorded from activity in the app (not from background polling). Per-person
        activity is kept for 3 days and only platform admins can see this panel; longer-term
        history is a daily count with no names attached.
      </p>
    </>
  );
}

/** The active-users chart (§14.5): daily, weekly and monthly lines on the shared ECharts
 *  wrapper. Days are UTC buckets (invariant 8), which the axis and tooltip say out loud. */
function ActiveUsersChart({
  history,
  build,
  onDataZoom,
}: {
  history: PresenceHistory | null;
  build: (env: ChartEnv) => ReturnType<typeof buildPresenceOption>;
  onDataZoom: (params: unknown) => void;
}) {
  if (!history) return <div className="presence-chart-empty muted">Loading chart…</div>;

  // No backfill: the series begins the day tracking shipped, so a young install has nothing
  // worth drawing. Say that rather than render a two-point "trend" (§14.5).
  if (!history.enoughHistory) {
    return (
      <div className="presence-chart-empty muted">
        Not enough history yet — the chart starts filling from the day presence tracking shipped.
        {history.points.length > 0 && ` So far: ${history.points.length} day(s) recorded.`}
      </div>
    );
  }

  return (
    <>
      <EChart
        className="presence-chart"
        testId="presence-chart"
        title="Daily, weekly and monthly active users"
        height={260}
        build={build}
        onDataZoom={onDataZoom}
      />
      <div className="stat-label" style={{ marginTop: 4 }}>
        UTC days · {history.points.length} days recorded · weekly and monthly lines are rolling
        counts, taken once a day
      </div>
    </>
  );
}

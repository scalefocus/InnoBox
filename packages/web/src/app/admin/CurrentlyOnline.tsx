"use client";
// The "Currently online" panel body (INNOBOX_SPEC.md §14.5) — platform admin only; the card
// wrapper and the gate live in admin/page.tsx.
//
// Deliberately NOT auto-refreshing (§14.5): a 5-minute window that silently ages for half an
// hour is worse than a stale one you can see, so the panel is an explicit snapshot with a
// "Refresh" button and an "as of" stamp. Nothing here polls.
//
// There is no "Reach out" action, unlike the sibling app this panel is modelled on: the panel
// answers *who is around*, and InnoBox has no direct-message channel to hand off to.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AvatarBubble } from "@/components/AvatarBubble";
import { useDateFmt } from "@/components/DateFormat";
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
  points: { day: string; activeUsers: number }[];
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
  const [range, setRange] = useState<PresenceRange>(DEFAULT_PRESENCE_RANGE);
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

  const load = useCallback(
    async (w: PresenceWindow, r: PresenceRange) => {
      setBusy(true);
      setError(null);
      try {
        const [s, h] = await Promise.all([
          fetch(`/api/admin/presence?window=${w}`, { cache: "no-store", headers: { accept: "application/json" } }),
          fetch(`/api/admin/presence/history?range=${r}`, { cache: "no-store", headers: { accept: "application/json" } }),
        ]);
        if (!s.ok || !h.ok) throw new Error("Could not load presence");
        const summaryJson = (await s.json()) as PresenceSummary;
        setSummary(summaryJson);
        setHistory((await h.json()) as PresenceHistory);
        reportTotal.current?.(summaryJson.total);
      } catch {
        setError("Could not load who is online.");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(window_, range);
  }, [load, window_, range]);

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
              className={range === r ? "btn btn-sm btn-primary" : "btn btn-sm"}
              onClick={() => setRange(r)}
              aria-pressed={range === r}
            >
              {r === "all" ? "All" : r}
            </button>
          ))}
        </div>
      </div>

      <ActiveUsersChart history={history} />

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
        <button type="button" className="btn btn-sm" onClick={() => void load(window_, range)} disabled={busy}>
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

/** The active-users line chart: hand-rolled SVG on the brand tokens, no charting dependency.
 *  Days are UTC buckets (invariant 8), which the axis says out loud. */
function ActiveUsersChart({ history }: { history: PresenceHistory | null }) {
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

  const W = 720;
  const H = 200;
  const padL = 34;
  const padR = 8;
  const padT = 10;
  const padB = 24;
  const points = history.points;

  // A "nice" ceiling so the gridline labels are whole numbers.
  const peak = Math.max(...points.map((p) => p.activeUsers), 1);
  const step = peak <= 5 ? 1 : peak <= 20 ? 5 : peak <= 100 ? 10 : 50;
  const top = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);

  const x = (i: number) => padL + (i * (W - padL - padR)) / Math.max(1, points.length - 1);
  const y = (v: number) => padT + (1 - v / top) * (H - padT - padB);

  // Midpoint smoothing (quadratic through segment midpoints) — the curve reads as a trend
  // without inventing values between days, which a spline through the points would.
  const path = points
    .map((p, i) => {
      const px = x(i);
      const py = y(p.activeUsers);
      if (i === 0) return `M ${px} ${py}`;
      const prevX = x(i - 1);
      const prevY = y(points[i - 1]!.activeUsers);
      const midX = (prevX + px) / 2;
      return `Q ${prevX} ${prevY} ${midX} ${(prevY + py) / 2} T ${px} ${py}`;
    })
    .join(" ");

  // First / middle / last, so a 90-day axis stays readable. MM-DD is unambiguous here
  // because the whole axis is one UTC series, and the label says UTC.
  const labelIndexes = points.length > 2 ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : [0, points.length - 1];

  return (
    <>
      <svg className="presence-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily active users">
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={padL}
              x2={W - padR}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--line)"
              strokeDasharray={v === 0 ? undefined : "3 4"}
            />
            <text x={padL - 8} y={y(v) + 4} textAnchor="end" fill="var(--faint)" fontSize="11">
              {v}
            </text>
          </g>
        ))}
        {labelIndexes.map((i) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} fill="var(--faint)" fontSize="11">
            {points[i]!.day.slice(5)}
          </text>
        ))}
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <div className="stat-label" style={{ marginTop: 0 }}>
        Distinct users per UTC day · {history.points.length} days shown
      </div>
    </>
  );
}

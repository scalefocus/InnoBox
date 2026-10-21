"use client";
// Platform-admin real user monitoring (INNOBOX_SPEC.md §14.12): how InnoBox feels in people's
// browsers — page views and sessions per page, the Core Web Vitals, the app's own API latency and
// failures, and the JavaScript errors that reached the console. Gated in-page against /api/me; the
// API is the real gate (403 to anyone who is not a platform admin).
//
// A snapshot, like Currently online: no auto-refresh, a Refresh button and an "as of" stamp.
// Nothing here is audited except the switch and the sample rate — the data names nobody.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_RUM_RANGE,
  RUM_ERROR_LIST_CAP,
  RUM_FLUSH_SCHEDULE_TEXT,
  RUM_RANGES,
  RUM_SAMPLE_RATES,
  apiErrorPercent,
  rumVerdict,
  type RumMetric,
  type RumRange,
  type RumRouteSummary,
  type RumSeriesPoint,
} from "@innobox/shared/rum";
import { cachedGet, invalidateApi } from "@/lib/ui";
import { readJson } from "@/lib/api-client";
import { relativeActive } from "@/lib/presence";
import { RUM_COLUMNS, formatRumCls, formatRumMs, formatRumPercent, sortRoutes, verdictLabel, verdictPillClass, type RumSortKey } from "@/lib/rum-format";
import { buildRumOption } from "@/lib/charts/rum-chart";
import type { ChartEnv } from "@/lib/charts/chart-env";
import { Breadcrumb, adminCrumbs } from "@/components/Breadcrumb";
import { useDateFmt } from "@/components/DateFormat";
import { EChart } from "@/components/EChart";

interface MeResponse {
  roles: { platformAdmin: boolean };
}

interface RumSettings {
  enabled: boolean;
  sampleRate: number;
}

interface Summary {
  asOf: string;
  source: "raw" | "rollup";
  routes: RumRouteSummary[];
  total: RumRouteSummary;
}

interface Series {
  enoughHistory: boolean;
  points: RumSeriesPoint[];
}

interface ErrorRow {
  fingerprint: string;
  message: string;
  source: string;
  frame: string;
  route: string;
  name: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
}

type ErrorSort = "last_seen" | "count";

export default function AdminMonitoringPage() {
  const [gate, setGate] = useState<"loading" | "forbidden" | "ok">("loading");

  useEffect(() => {
    let live = true;
    cachedGet<MeResponse>("/api/me")
      .then((me) => live && setGate(me.roles.platformAdmin ? "ok" : "forbidden"))
      .catch(() => live && setGate("forbidden"));
    return () => {
      live = false;
    };
  }, []);

  return (
    <>
      <div className="page-head reveal">
        {gate === "ok" && <Breadcrumb items={adminCrumbs("Real user monitoring")} />}
        <h1 className="page-title">Real user monitoring</h1>
        <p className="page-sub">
          How InnoBox performs in people&apos;s browsers: page views, load and responsiveness, the app&apos;s own requests, and the
          script errors people run into.
        </p>
      </div>
      {gate === "loading" && <p className="muted">Loading…</p>}
      {gate === "forbidden" && (
        <div className="card card-pad">
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 18, marginBottom: 6 }}>Real user monitoring is restricted</h2>
          <p className="muted" style={{ margin: 0 }}>
            Only platform admins can see this page.
          </p>
        </div>
      )}
      {gate === "ok" && <Monitoring />}
    </>
  );
}

function Monitoring() {
  const fmt = useDateFmt();
  const [settings, setSettings] = useState<RumSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [range, setRange] = useState<RumRange>(DEFAULT_RUM_RANGE);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [series, setSeries] = useState<Series | null>(null);
  // `loadedAt` is when the list arrived — the reference for its "3m ago" stamps (never read during render).
  const [errors, setErrors] = useState<{ errors: ErrorRow[]; total: number; loadedAt: number } | null>(null);
  const [errorSort, setErrorSort] = useState<ErrorSort>("last_seen");
  const [sort, setSort] = useState<{ key: RumSortKey; desc: boolean }>({ key: "views", desc: true });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const notify = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    fetch("/api/admin/rum/settings", { headers: { accept: "application/json" } })
      .then(async (res) => (res.ok ? setSettings((await res.json()) as RumSettings) : setProblem("Could not load the monitoring settings.")))
      .catch(() => setProblem("Could not load the monitoring settings."));
  }, []);

  const load = useCallback(async (r: RumRange) => {
    setBusy(true);
    try {
      const get = async <T,>(url: string): Promise<T> => {
        const res = await fetch(url, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(String((await readJson(res)).error ?? res.status));
        return (await res.json()) as T;
      };
      const [s, c] = await Promise.all([get<Summary>(`/api/admin/rum/summary?range=${r}`), get<Series>(`/api/admin/rum/series?range=${r}`)]);
      setSummary(s);
      setSeries(c);
      setProblem(null);
    } catch {
      setProblem("Could not load the monitoring data.");
    } finally {
      setBusy(false);
    }
  }, []);

  const loadErrors = useCallback(async (r: RumRange, s: ErrorSort) => {
    try {
      const res = await fetch(`/api/admin/rum/errors?range=${r}&sort=${s}`, { headers: { accept: "application/json" } });
      if (res.ok) setErrors({ ...((await res.json()) as { errors: ErrorRow[]; total: number }), loadedAt: Date.now() });
    } catch {
      /* the list keeps its last state; the summary reports the failure */
    }
  }, []);

  useEffect(() => {
    void load(range);
  }, [load, range]);

  useEffect(() => {
    void loadErrors(range, errorSort);
  }, [loadErrors, range, errorSort]);

  const refresh = () => {
    void load(range);
    void loadErrors(range, errorSort);
  };

  const saveSettings = async (patch: Partial<RumSettings>) => {
    if (!settings) return;
    const previous = settings;
    setSettings({ ...settings, ...patch });
    setSavingSettings(true);
    try {
      const res = await fetch("/api/admin/rum/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "Could not save the monitoring settings.");
      setSettings(json as unknown as RumSettings);
      // The collector reads these from /api/me on the next page load.
      invalidateApi("/api/me");
      notify(
        patch.enabled === undefined
          ? `Sampling ${String(patch.sampleRate)} % of new sessions.`
          : patch.enabled
            ? "Collecting telemetry from the next page load."
            : "Telemetry collection is off.",
      );
    } catch (err) {
      setSettings(previous);
      notify(err instanceof Error ? err.message : "Could not save the monitoring settings.");
    } finally {
      setSavingSettings(false);
    }
  };

  const buildChart = useCallback((env: ChartEnv) => buildRumOption({ points: series?.points ?? [], style: fmt.style, env }), [series, fmt.style]);

  const rows = useMemo(() => (summary ? sortRoutes(summary.routes, sort.key, sort.desc) : []), [summary, sort]);
  const chooseSort = (key: RumSortKey) =>
    setSort((cur) => (cur.key === key ? { key, desc: !cur.desc } : { key, desc: key !== "name" }));

  const rollup = summary?.source === "rollup";

  return (
    <>
      <section className="card card-pad reveal rum-section" aria-label="Collection and range">
        <div className="rum-controls">
          <div className="toggle-field">
            <span className="rum-control-label">Collect telemetry</span>
            <span className={`toggle-state${settings?.enabled ? " is-on" : ""}`} aria-hidden="true">
              {settings?.enabled ? "On" : "Off"}
            </span>
            <button
              type="button"
              className="toggle toggle-pref"
              role="switch"
              aria-checked={Boolean(settings?.enabled)}
              aria-label="Collect telemetry"
              disabled={!settings || savingSettings}
              onClick={() => settings && void saveSettings({ enabled: !settings.enabled })}
            >
              <span className="toggle-knob" aria-hidden="true">
                {settings?.enabled ? "●" : "·"}
              </span>
            </button>
          </div>
          <label className="rum-sample">
            <span className="rum-control-label">Sample</span>
            <select
              className="field"
              value={settings?.sampleRate ?? 100}
              disabled={!settings || savingSettings}
              onChange={(e) => void saveSettings({ sampleRate: Number(e.target.value) })}
            >
              {RUM_SAMPLE_RATES.map((rate) => (
                <option key={rate} value={rate}>
                  {rate} %
                </option>
              ))}
            </select>
            <span className="muted">of sessions</span>
          </label>
          <span className="muted rum-schedule">Sampling decided once per browser tab; {RUM_FLUSH_SCHEDULE_TEXT}.</span>
        </div>
        <div className="presence-head" style={{ marginTop: 14, marginBottom: 0 }}>
          <div className="presence-toggles" role="group" aria-label="Range">
            {RUM_RANGES.map((r) => (
              <button key={r} type="button" className={range === r ? "btn btn-sm btn-primary" : "btn btn-sm"} aria-pressed={range === r} onClick={() => setRange(r)}>
                {r === "all" ? "All" : r}
              </button>
            ))}
          </div>
          <div className="rum-refresh">
            <span className="muted">{summary && <>as of {fmt.time(summary.asOf)}</>}</span>
            <button type="button" className="btn btn-sm" onClick={refresh} disabled={busy}>
              {busy ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
      </section>

      {problem && <p className="muted">{problem}</p>}

      <section className="card card-pad reveal rum-section" aria-label="Page views, p75 LCP and p75 INP per day">
        <div className="stat-label" style={{ marginTop: 0, marginBottom: 10 }}>
          Page views · p75 LCP · p75 INP <span className="rum-caption">per UTC day, from the daily rollup</span>
        </div>
        {!series && <p className="muted">Loading…</p>}
        {series && !series.enoughHistory && (
          <p className="presence-chart-empty muted">Not enough history yet — the chart starts filling from the day collection was switched on.</p>
        )}
        {series && series.enoughHistory && (
          <EChart build={buildChart} title="Page views, p75 LCP and p75 INP per UTC day" height={260} className="presence-chart" testId="rum-chart" />
        )}
      </section>

      <section className="card card-pad reveal rum-section" aria-labelledby="rum-routes-heading">
        <div className="rum-section-head">
          <h2 id="rum-routes-heading" className="stat-label" style={{ margin: 0 }}>
            Routes
          </h2>
          <span className="rum-caption">
            {rollup
              ? `${range === "all" ? "All" : range} read the daily rollup: vitals are the views-weighted mean of each day's p75 (a percentile can't be re-aggregated), and sessions add up per day.`
              : "Last 7 days from raw page views: every vital is a true 75th percentile."}
          </span>
        </div>
        <div className="rum-table-wrap">
          <table className="rum-table" data-testid="rum-routes">
            <thead>
              <tr>
                {RUM_COLUMNS.map((c) => (
                  <th key={c.key} scope="col" aria-sort={sort.key === c.key ? (sort.desc ? "descending" : "ascending") : "none"}>
                    <button type="button" className="rum-sort" onClick={() => chooseSort(c.key)}>
                      {c.label}
                      {sort.key === c.key && <span aria-hidden="true">{sort.desc ? " ↓" : " ↑"}</span>}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summary && <RouteRow row={summary.total} total />}
              {rows.map((row) => (
                <RouteRow key={row.route} row={row} />
              ))}
              {summary && rows.length === 0 && (
                <tr>
                  <td colSpan={RUM_COLUMNS.length} className="muted rum-empty">
                    No page views in this range{settings && !settings.enabled ? " — collection is off." : "."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card card-pad reveal rum-section" aria-labelledby="rum-errors-heading">
        <div className="rum-section-head">
          <h2 id="rum-errors-heading" className="stat-label" style={{ margin: 0 }}>
            Client errors · {errors?.total ?? "…"}
          </h2>
          <div className="presence-toggles" role="group" aria-label="Sort errors">
            {(["last_seen", "count"] as const).map((s) => (
              <button key={s} type="button" className={errorSort === s ? "btn btn-sm btn-primary" : "btn btn-sm"} aria-pressed={errorSort === s} onClick={() => setErrorSort(s)}>
                {s === "last_seen" ? "Last seen" : "Count"}
              </button>
            ))}
          </div>
        </div>
        {errors && errors.errors.length === 0 && <p className="muted" style={{ margin: 0 }}>No client errors in this range.</p>}
        {errors && errors.errors.length > 0 && (
          <ul className="rum-errors">
            {errors.errors.map((e) => (
              <li key={e.fingerprint}>
                <details className="rum-error">
                  <summary>
                    <span className="rum-error-msg">{e.message}</span>
                    <span className="chip">×{e.count}</span>
                    <span className="muted rum-error-when">{relativeActive(e.lastSeen, errors.loadedAt)}</span>
                  </summary>
                  <div className="rum-error-body">
                    <p className="rum-error-full">{e.message}</p>
                    <dl>
                      <dt>Route</dt>
                      <dd>{e.name}</dd>
                      <dt>Source</dt>
                      <dd className="mono">{e.source || "—"}</dd>
                      <dt>Frame</dt>
                      <dd className="mono">{e.frame || "—"}</dd>
                      <dt>First seen</dt>
                      <dd>{fmt.dateTime(e.firstSeen)}</dd>
                      <dt>Last seen</dt>
                      <dd>{fmt.dateTime(e.lastSeen)}</dd>
                    </dl>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
        {errors && errors.total > errors.errors.length && (
          <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
            Showing {errors.errors.length} of {errors.total} · capped at {RUM_ERROR_LIST_CAP}
          </p>
        )}
      </section>

      {/* The page says what it records: no covert monitoring. */}
      <p className="muted" style={{ fontSize: 12.5 }}>
        Performance beacons are collected in the browser only while collection is on. They carry no user identity and name pages by type,
        never by item. Per-view detail is kept for 7 days and daily totals after that; error details for 90 days after they were last
        seen. Only platform admins can see this page.
      </p>

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

function MetricCell({ metric, value }: { metric: RumMetric; value: number | null }) {
  const verdict = rumVerdict(metric, value);
  const shown = metric === "cls" ? formatRumCls(value) : formatRumMs(value);
  if (!verdict) return <td className="muted">{shown}</td>;
  return (
    <td>
      <span className={`pill ${verdictPillClass(verdict)}`} aria-label={`${shown}, ${verdictLabel(verdict)}`}>
        {shown}
      </span>
    </td>
  );
}

function RouteRow({ row, total = false }: { row: RumRouteSummary; total?: boolean }) {
  return (
    <tr className={total ? "rum-total" : undefined}>
      <th scope="row">{row.name}</th>
      <td>{row.views.toLocaleString("en")}</td>
      <td>{row.sessions.toLocaleString("en")}</td>
      <MetricCell metric="lcp" value={row.p75.lcp} />
      <MetricCell metric="inp" value={row.p75.inp} />
      <MetricCell metric="cls" value={row.p75.cls} />
      <MetricCell metric="ttfb" value={row.p75.ttfb} />
      <MetricCell metric="nav" value={row.p75.nav} />
      <MetricCell metric="api" value={row.p75.api} />
      <td>{formatRumPercent(apiErrorPercent(row.apiErrors, row.apiCalls))}</td>
      <td>{row.clientErrors.toLocaleString("en")}</td>
    </tr>
  );
}

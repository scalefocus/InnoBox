"use client";
// The "Survey results" card (INNOBOX_SPEC.md §14.11) — platform admins only (the console renders
// it only for them, and the API answers 403 to anyone else). The platform switches — the survey
// and, beside it, bug reports (§13.10) — sit in the card's action slot, usable while collapsed.
//
// Privacy is enforced by the server: figures over fewer than 5 responses arrive already withheld
// (null + `withheld`), the current UTC day is excluded, and the feed carries dates only. This file
// just renders what it is given. Free text is always rendered as plain text. Nothing polls; there
// is no export.
import { useCallback, useEffect, useRef, useState } from "react";
import { useDateFmt, type DateStyle } from "@/components/DateFormat";
import { EChart } from "@/components/EChart";
import type { ChartEnv } from "@/lib/charts/chart-env";
import { buildSurveyTrendOption } from "@/lib/charts/survey-trend-chart";
import { formatCalendarDay } from "@innobox/shared/calendar-day";
import {
  SURVEY_FEATURES,
  SURVEY_SEGMENTS,
  SURVEY_SEGMENT_LABEL,
  surveyFeatureLabel,
  type SurveyFeature,
  type SurveyResponseTrigger,
  type SurveySegment,
} from "@innobox/shared/survey";
import {
  DEFAULT_SURVEY_RANGE,
  SURVEY_COMMENTS_PAGE,
  SURVEY_RANGES,
  SURVEY_RANGE_LABEL,
  SURVEY_SOURCES,
  SURVEY_SOURCE_LABEL,
  type SurveyBucket,
  type SurveyRange,
  type SurveySeriesPoint,
  type SurveySource,
} from "@innobox/shared/survey-results";
import { AdminCard } from "./AdminCard";

interface Summary {
  enabled: boolean;
  bugReportsEnabled: boolean;
  lastDate: string | null;
  bucket: SurveyBucket;
  bugCount: number;
  funnel: {
    shown: number;
    closed: number;
    submitted: number;
    submittedFromMenu: number;
    optedOut: number;
    shownSelf: number;
    submittedSelf: number;
    submittedBug: number;
  };
  series: SurveySeriesPoint[];
  questions: { key: string; text: string; retired: boolean; n: number; avg: number | null; distribution: number[] | null; withheld: boolean }[];
  features: { key: SurveyFeature; label: string; n: number }[];
}

interface Comment {
  id: string;
  answeredOn: string;
  feature: SurveyFeature | null;
  segment: SurveySegment;
  trigger: SurveyResponseTrigger;
  text: string;
  /** Bug reports only: the page path (plain text, never a link) and the app version. */
  pagePath: string | null;
  appVersion: string | null;
}

interface CommentsPage {
  comments: Comment[];
  total: number;
  hasMore: boolean;
  withheld: boolean;
}

const WITHHELD_NOTE = "Not enough responses yet (fewer than 5).";

export function SurveyResultsCard({ open, onToggle, onNotify }: { open: boolean; onToggle: () => void; onNotify: (message: string) => void }) {
  const fmt = useDateFmt();
  const day = (d: string) => formatCalendarDay(d, fmt.style);

  const [range, setRange] = useState<SurveyRange>(DEFAULT_SURVEY_RANGE);
  const [segment, setSegment] = useState<SurveySegment | "all">("all");
  const [feature, setFeature] = useState<SurveyFeature | "all">("all");
  const [source, setSource] = useState<SurveySource>("all");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [summaryError, setSummaryError] = useState(false);
  const [feed, setFeed] = useState<CommentsPage | null>(null);
  const [feedBusy, setFeedBusy] = useState(false);
  const surveySwitch = useSettingSwitch("surveyEnabled");
  const bugSwitch = useSettingSwitch("bugReportsEnabled");
  // The feed loads on first expand, then follows the filters (re-collapsing never refetches).
  const [feedRequested, setFeedRequested] = useState(open);
  if (open && !feedRequested) setFeedRequested(true);

  const query = useCallback(
    (extra: Record<string, string> = {}) => {
      const params = new URLSearchParams({ range, source, ...extra });
      if (segment !== "all") params.set("segment", segment);
      if (feature !== "all") params.set("feature", feature);
      return params.toString();
    },
    [range, segment, feature, source],
  );

  const loadSummary = useCallback(async () => {
    setSummaryError(false);
    try {
      const res = await fetch(`/api/admin/survey/summary?${query()}`, { cache: "no-store", headers: { accept: "application/json" } });
      if (!res.ok) throw new Error();
      const json = (await res.json()) as Summary;
      setSummary(json);
      surveySwitch.sync(json.enabled);
      bugSwitch.sync(json.bugReportsEnabled);
    } catch {
      setSummaryError(true);
    }
  }, [query, surveySwitch.sync, bugSwitch.sync]);

  const loadFeed = useCallback(
    async (offset: number) => {
      setFeedBusy(true);
      try {
        const res = await fetch(`/api/admin/survey/comments?${query({ offset: String(offset), limit: String(SURVEY_COMMENTS_PAGE) })}`, {
          cache: "no-store",
          headers: { accept: "application/json" },
        });
        if (!res.ok) throw new Error();
        const page = (await res.json()) as CommentsPage;
        setFeed((current) => (offset > 0 && current ? { ...page, comments: [...current.comments, ...page.comments] } : page));
      } catch {
        onNotify("Could not load survey comments");
      } finally {
        setFeedBusy(false);
      }
    },
    [query, onNotify],
  );

  // The summary loads on mount (it feeds the header count) and on every range/filter change.
  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    if (feedRequested) void loadFeed(0);
  }, [loadFeed, feedRequested]);

  const toggleSurvey = async () => {
    const saved = await surveySwitch.toggle();
    if (saved !== null) onNotify(saved ? "Surveys are on" : "Surveys are off");
    else onNotify("Could not change the survey switch");
    void loadSummary();
  };

  const toggleBugs = async () => {
    const saved = await bugSwitch.toggle();
    if (saved !== null) onNotify(saved ? "Bug reports are on" : "Bug reports are off");
    else onNotify("Could not change the bug-report switch");
    void loadSummary();
  };

  const remove = async (id: string, isBug: boolean) => {
    if (!window.confirm(isBug ? "Delete this bug report?" : "Delete this response? Its star answers are removed too.")) return;
    try {
      const res = await fetch(`/api/admin/survey/responses/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      onNotify("Response deleted");
      void loadSummary();
      void loadFeed(0);
    } catch {
      onNotify("Could not delete the response");
    }
  };

  const responseCount = summary ? summary.series.reduce((sum, p) => sum + p.n, 0) : null;
  const bugCount = summary?.bugCount ?? 0;
  const headerSummary =
    responseCount === null
      ? "…"
      : `${responseCount} ${responseCount === 1 ? "response" : "responses"} · ${bugCount} ${bugCount === 1 ? "bug report" : "bug reports"} in range`;

  const action = (
    <div className="survey-switches">
      <PrefSwitch label="Feedback survey" testId="survey-switch" state={surveySwitch} onIcon="💬" offIcon="🔕" onToggle={toggleSurvey} />
      <PrefSwitch label="Bug reports" visibleLabel testId="bug-reports-switch" state={bugSwitch} onIcon="🐞" offIcon="🔕" onToggle={toggleBugs} />
    </div>
  );

  const f = summary?.funnel;
  const rate = f && f.shown > 0 ? Math.round((f.submitted / f.shown) * 100) : null;

  return (
    <AdminCard
      id="survey"
      title="Survey results"
      summary={headerSummary}
      open={open}
      onToggle={onToggle}
      action={action}
    >
      <div data-testid="survey-results">
        {summary && !summary.enabled && (
          <p className="muted" style={{ marginTop: 0 }}>
            Surveys are off.{summary.lastDate ? ` Showing responses collected until ${day(summary.lastDate)}.` : ""}
          </p>
        )}

        <div className="presence-head">
          <div className="stat-label" style={{ marginTop: 0 }}>
            Range · today is not included
          </div>
          <div className="presence-toggles">
            {SURVEY_RANGES.map((r) => (
              <button key={r} type="button" className={range === r ? "btn btn-sm btn-primary" : "btn btn-sm"} aria-pressed={range === r} onClick={() => setRange(r)}>
                {SURVEY_RANGE_LABEL[r]}
              </button>
            ))}
          </div>
        </div>

        {summaryError && <p className="muted">Could not load the survey results.</p>}
        {!summaryError && !summary && <p className="muted">Loading…</p>}

        {f && (
          <>
            <div className="survey-funnel" data-testid="survey-funnel">
              <span>
                <strong>{f.shown}</strong>shown
              </span>
              <span>
                <strong>{f.closed}</strong>closed on sight
              </span>
              <span>
                <strong>{f.submitted}</strong>submitted
                {f.submittedFromMenu > 0 && <span className="muted"> (… of which {f.submittedFromMenu} later, from the menu)</span>}
              </span>
              <span>
                <strong>{rate === null ? "–" : `${rate}%`}</strong>response rate
              </span>
              <span>
                <strong>{f.optedOut}</strong>opted out
              </span>
            </div>
            <p className="muted" style={{ fontSize: 13, margin: "0 0 4px" }}>
              Self-initiated: {f.shownSelf} opened · {f.submittedSelf} submitted
            </p>
            <p className="muted" style={{ fontSize: 13, margin: "0 0 14px" }} data-testid="survey-funnel-bugs">
              Bug reports: {f.submittedBug} submitted
            </p>
          </>
        )}

        <div className="survey-filters">
          <label className="sr-only" htmlFor="survey-segment">
            Segment
          </label>
          <select id="survey-segment" className="field" value={segment} onChange={(e) => setSegment(e.target.value as SurveySegment | "all")}>
            <option value="all">All segments</option>
            {SURVEY_SEGMENTS.map((s) => (
              <option key={s} value={s}>
                {SURVEY_SEGMENT_LABEL[s]}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="survey-feature">
            Feature
          </label>
          <select id="survey-feature" className="field" value={feature} onChange={(e) => setFeature(e.target.value as SurveyFeature | "all")}>
            <option value="all">All features</option>
            {/* Every feature with responses in range — plus the one selected, so it never vanishes. */}
            {SURVEY_FEATURES.filter((x) => x.key === feature || summary?.features.some((y) => y.key === x.key)).map((x) => (
              <option key={x.key} value={x.key}>
                {capitalize(x.label)}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="survey-source">
            Source
          </label>
          <select id="survey-source" className="field" value={source} onChange={(e) => setSource(e.target.value as SurveySource)} data-testid="survey-source">
            {SURVEY_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s === "all" ? "All sources" : SURVEY_SOURCE_LABEL[s]}
              </option>
            ))}
          </select>
        </div>

        {summary && summary.series.length === 0 && <p className="muted">Responses appear here as people answer the survey.</p>}

        {summary && summary.series.length > 0 && (
          <>
            <div className="stat-label" style={{ marginTop: 0 }}>
              Satisfaction · average of &quot;Overall&quot; per {summary.bucket}, responses as bars
            </div>
            <SatisfactionTrend series={summary.series} style={fmt.style} />

            <div className="survey-questions">
              {summary.questions.map((q) => (
                <div className="survey-qcard" key={q.key} data-testid="survey-question">
                  <div className="survey-qcard-text">
                    {q.text} {q.retired && <span className="pill pill-muted">retired</span>}
                  </div>
                  {q.withheld ? (
                    <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
                      {WITHHELD_NOTE}
                    </p>
                  ) : (
                    <>
                      <div>
                        <span className="survey-qcard-avg">{q.avg?.toFixed(1)} ★</span> <span className="muted">n = {q.n}</span>
                      </div>
                      <Histogram distribution={q.distribution ?? []} />
                    </>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        <div className="stat-label">Comments</div>
        {!feed && feedBusy && <p className="muted">Loading…</p>}
        {/* Survey comments under 5 are withheld; bug reports in range are still listed below the note. */}
        {feed?.withheld && <p className="muted">{feed.total === 0 && feed.comments.length === 0 ? "No comments in range." : WITHHELD_NOTE}</p>}
        {feed && !feed.withheld && feed.comments.length === 0 && <p className="muted">No comments in range.</p>}
        {feed && feed.comments.length > 0 && (
          <>
            <div className="rows" style={{ marginTop: 8 }}>
              {feed.comments.map((c) => (
                <div className="row" key={c.id} data-testid="survey-comment" style={{ alignItems: "flex-start" }}>
                  <span className="grow">
                    {/* Plain text, always — never HTML. */}
                    <div className="survey-feed-text">{c.text}</div>
                    <div className="sub">
                      {day(c.answeredOn)} ·{" "}
                      {c.trigger === "bug" ? (
                        <span className="pill pill-warn">Bug</span>
                      ) : c.feature ? (
                        capitalize(surveyFeatureLabel(c.feature))
                      ) : (
                        "General"
                      )}{" "}
                      · {SURVEY_SEGMENT_LABEL[c.segment]}
                      {c.trigger === "self" && (
                        <>
                          {" "}
                          · <span className="pill pill-accent">Self-initiated</span>
                        </>
                      )}
                    </div>
                    {c.trigger === "bug" && (
                      <div className="survey-bug-meta" data-testid="survey-bug-meta">
                        {/* Plain text, never a link. */}
                        <div className="mono">{c.pagePath ?? "(page not recorded)"}</div>
                        <div>Version {c.appVersion ?? "unknown"}</div>
                      </div>
                    )}
                  </span>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(c.id, c.trigger === "bug")}>
                    Delete
                  </button>
                </div>
              ))}
            </div>
            {feed.hasMore && (
              <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} disabled={feedBusy} onClick={() => loadFeed(feed.comments.length)}>
                {feedBusy ? "Loading…" : "Show more"}
              </button>
            )}
          </>
        )}

        <p className="muted" style={{ fontSize: 12.5, marginBottom: 0, marginTop: 14 }}>
          Responses are stored without names. Figures based on fewer than 5 responses are hidden (bug reports are always listed), and today&apos;s answers appear tomorrow.
        </p>
      </div>
    </AdminCard>
  );
}

type SettingKey = "surveyEnabled" | "bugReportsEnabled";

interface SettingSwitch {
  value: boolean | null;
  busy: boolean;
  /** Adopts the server's value unless a flip is in flight. */
  sync: (value: boolean) => void;
  /** Flips optimistically and saves; resolves with the saved value, or null (reverted) on failure. */
  toggle: () => Promise<boolean | null>;
}

/** One platform switch in the card's action slot. Synchronous mirrors: a second click can arrive
 *  before React re-renders the busy state, and a summary fetched before a flip must not overwrite it. */
function useSettingSwitch(key: SettingKey): SettingSwitch {
  const [value, setValueState] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const valueRef = useRef<boolean | null>(null);
  const busyRef = useRef(false);
  const setValue = useCallback((v: boolean) => {
    valueRef.current = v;
    setValueState(v);
  }, []);
  const sync = useCallback(
    (v: boolean) => {
      if (!busyRef.current) setValue(v);
    },
    [setValue],
  );
  const toggle = useCallback(async (): Promise<boolean | null> => {
    const current = valueRef.current;
    if (current === null || busyRef.current) return current;
    busyRef.current = true;
    setBusy(true);
    setValue(!current); // optimistic
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [key]: !current }),
      });
      if (!res.ok) throw new Error();
      const saved = ((await res.json()) as Partial<Record<SettingKey, boolean>>)[key] === true;
      setValue(saved);
      return saved;
    } catch {
      setValue(current);
      return null;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [key, setValue]);
  return { value, busy, sync, toggle };
}

/** The §2.2 preference pill, as the card's action slot uses it. */
function PrefSwitch({
  label,
  visibleLabel = false,
  testId,
  state,
  onIcon,
  offIcon,
  onToggle,
}: {
  label: string;
  visibleLabel?: boolean;
  testId: string;
  state: SettingSwitch;
  onIcon: string;
  offIcon: string;
  onToggle: () => void;
}) {
  const on = state.value ?? true;
  return (
    <div className="toggle-field">
      {visibleLabel && (
        <span className="survey-switch-label" aria-hidden="true">
          {label}
        </span>
      )}
      <span className={`toggle-state${on ? " is-on" : ""}`} aria-hidden="true">
        {on ? "On" : "Off"}
      </span>
      <button
        type="button"
        className="toggle toggle-pref"
        role="switch"
        aria-checked={on}
        aria-label={label}
        data-testid={testId}
        disabled={state.value === null || state.busy}
        onClick={onToggle}
      >
        <span className="toggle-knob" aria-hidden="true">
          {on ? onIcon : offIcon}
        </span>
      </button>
    </div>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function Histogram({ distribution }: { distribution: number[] }) {
  const peak = Math.max(1, ...distribution);
  return (
    <>
      <div className="survey-hist" aria-label={`Answers by stars: ${distribution.map((n, i) => `${i + 1}★ ${n}`).join(", ")}`} role="img">
        {distribution.map((n, i) => (
          <span key={i} style={{ height: `${Math.max(4, (n / peak) * 100)}%`, opacity: n === 0 ? 0.25 : 1 }} />
        ))}
      </div>
      <div className="survey-hist-labels" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((s) => (
          <span key={s}>{s}★</span>
        ))}
      </div>
    </>
  );
}

/** The satisfaction trend (§14.11) on the shared ECharts wrapper (§14.5). Bars = responses per
 *  bucket; the line = the average of "Overall" (1–5), with a BREAK wherever the server withheld
 *  it. Markers when there are fewer than 3 points, and on any point with no drawn neighbour. */
function SatisfactionTrend({ series, style }: { series: SurveySeriesPoint[]; style: DateStyle }) {
  const build = useCallback((env: ChartEnv) => buildSurveyTrendOption({ series, style, env }), [series, style]);
  return (
    <div style={{ marginBottom: 6 }}>
      <EChart
        className="presence-chart"
        testId="survey-trend-chart"
        title="Average overall satisfaction over time"
        height={200}
        build={build}
      />
    </div>
  );
}

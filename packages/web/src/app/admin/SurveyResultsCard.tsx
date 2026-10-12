"use client";
// The "Survey results" card (INNOBOX_SPEC.md §14.11) — platform admins only (the console renders
// it only for them, and the API answers 403 to anyone else). The platform switch sits in the
// card's action slot, usable while collapsed.
//
// Privacy is enforced by the server: figures over fewer than 5 responses arrive already withheld
// (null + `withheld`), the current UTC day is excluded, and the feed carries dates only. This file
// just renders what it is given. Free text is always rendered as plain text. Nothing polls; there
// is no export.
import { useCallback, useEffect, useRef, useState } from "react";
import { useDateFmt } from "@/components/DateFormat";
import {
  SURVEY_FEATURES,
  SURVEY_SEGMENTS,
  SURVEY_SEGMENT_LABEL,
  surveyFeatureLabel,
  type SurveyFeature,
  type SurveySegment,
  type SurveyTrigger,
} from "@innobox/shared/survey";
import {
  DEFAULT_SURVEY_RANGE,
  SURVEY_COMMENTS_PAGE,
  SURVEY_RANGES,
  SURVEY_RANGE_LABEL,
  SURVEY_SOURCES,
  SURVEY_SOURCE_LABEL,
  formatCalendarDay,
  type SurveyBucket,
  type SurveyRange,
  type SurveySeriesPoint,
  type SurveySource,
} from "@innobox/shared/survey-results";
import { AdminCard } from "./AdminCard";

interface Summary {
  enabled: boolean;
  lastDate: string | null;
  bucket: SurveyBucket;
  funnel: {
    shown: number;
    closed: number;
    submitted: number;
    submittedFromMenu: number;
    optedOut: number;
    shownSelf: number;
    submittedSelf: number;
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
  trigger: SurveyTrigger;
  text: string;
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
  const [enabled, setEnabledState] = useState<boolean | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);
  // Synchronous mirrors for the switch: a second click can arrive before React re-renders the
  // busy state, and a summary fetched before a flip must not overwrite it.
  const enabledRef = useRef<boolean | null>(null);
  const busyRef = useRef(false);
  const setEnabled = useCallback((value: boolean) => {
    enabledRef.current = value;
    setEnabledState(value);
  }, []);
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
      if (!busyRef.current) setEnabled(json.enabled);
    } catch {
      setSummaryError(true);
    }
  }, [query, setEnabled]);

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

  const toggleSwitch = async () => {
    const current = enabledRef.current;
    if (current === null || busyRef.current) return;
    busyRef.current = true;
    setSwitchBusy(true);
    const next = !current;
    setEnabled(next); // optimistic
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ surveyEnabled: next }),
      });
      if (!res.ok) throw new Error();
      const saved = ((await res.json()) as { surveyEnabled?: boolean }).surveyEnabled === true;
      setEnabled(saved);
      onNotify(saved ? "Surveys are on" : "Surveys are off");
    } catch {
      setEnabled(current);
      onNotify("Could not change the survey switch");
    } finally {
      busyRef.current = false;
      setSwitchBusy(false);
    }
    void loadSummary();
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this response? Its star answers are removed too.")) return;
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
  const switchOn = enabled ?? true;

  const action = (
    <div className="toggle-field">
      <span className={`toggle-state${switchOn ? " is-on" : ""}`} aria-hidden="true">
        {switchOn ? "On" : "Off"}
      </span>
      <button
        type="button"
        className="toggle toggle-pref"
        role="switch"
        aria-checked={switchOn}
        aria-label="Feedback survey"
        data-testid="survey-switch"
        disabled={enabled === null || switchBusy}
        onClick={toggleSwitch}
      >
        <span className="toggle-knob" aria-hidden="true">
          {switchOn ? "💬" : "🔕"}
        </span>
      </button>
    </div>
  );

  const f = summary?.funnel;
  const rate = f && f.shown > 0 ? Math.round((f.submitted / f.shown) * 100) : null;

  return (
    <AdminCard
      id="survey"
      title="Survey results"
      summary={responseCount === null ? "…" : `${responseCount} ${responseCount === 1 ? "response" : "responses"} in range`}
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
            <p className="muted" style={{ fontSize: 13, margin: "0 0 14px" }}>
              Self-initiated: {f.shownSelf} opened · {f.submittedSelf} submitted
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
            <SatisfactionTrend series={summary.series} label={day} />

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
        {feed?.withheld && <p className="muted">{feed.total === 0 ? "No comments in range." : WITHHELD_NOTE}</p>}
        {feed && !feed.withheld && (
          <>
            <div className="rows" style={{ marginTop: 8 }}>
              {feed.comments.map((c) => (
                <div className="row" key={c.id} data-testid="survey-comment" style={{ alignItems: "flex-start" }}>
                  <span className="grow">
                    {/* Plain text, always — never HTML. */}
                    <div className="survey-feed-text">{c.text}</div>
                    <div className="sub">
                      {day(c.answeredOn)} · {c.feature ? capitalize(surveyFeatureLabel(c.feature)) : "General"} · {SURVEY_SEGMENT_LABEL[c.segment]}
                      {c.trigger === "self" && (
                        <>
                          {" "}
                          · <span className="pill pill-accent">Self-initiated</span>
                        </>
                      )}
                    </div>
                  </span>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove(c.id)}>
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
          Responses are stored without names. Figures based on fewer than 5 responses are hidden, and today&apos;s answers appear tomorrow.
        </p>
      </div>
    </AdminCard>
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

/** The satisfaction trend: hand-rolled SVG on the brand tokens, no charting dependency (as the
 *  §14.5 chart). Bars = responses per bucket; the line = the average of "Overall" (1–5), with a
 *  GAP wherever the server withheld it. Fewer than 3 points get visible markers. */
function SatisfactionTrend({ series, label }: { series: SurveySeriesPoint[]; label: (day: string) => string }) {
  const W = 720;
  const H = 180;
  const padL = 30;
  const padR = 30;
  const padT = 10;
  const padB = 24;
  const innerW = W - padL - padR;
  const band = innerW / series.length;
  const x = (i: number) => padL + band * (i + 0.5);
  const yAvg = (v: number) => padT + (1 - (v - 1) / 4) * (H - padT - padB);
  const peakN = Math.max(1, ...series.map((p) => p.n));
  const barH = (n: number) => (n / peakN) * (H - padT - padB) * 0.6;

  // Split the line at withheld buckets — a gap, never an interpolation.
  const segments: string[] = [];
  let current: string[] = [];
  series.forEach((p, i) => {
    if (p.overallAvg === null) {
      if (current.length) segments.push(current.join(" "));
      current = [];
      return;
    }
    current.push(`${current.length ? "L" : "M"} ${x(i)} ${yAvg(p.overallAvg)}`);
  });
  if (current.length) segments.push(current.join(" "));
  const markers = series.length < 3;
  const labelIndexes = series.length > 2 ? [0, Math.floor((series.length - 1) / 2), series.length - 1] : series.map((_, i) => i);

  return (
    <svg className="presence-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Average overall satisfaction over time" style={{ marginBottom: 6 }}>
      {[1, 2, 3, 4, 5].map((v) => (
        <g key={v}>
          <line x1={padL} x2={W - padR} y1={yAvg(v)} y2={yAvg(v)} stroke="var(--line)" strokeDasharray={v === 1 ? undefined : "3 4"} />
          <text x={padL - 8} y={yAvg(v) + 4} textAnchor="end" fill="var(--faint)" fontSize="11">
            {v}★
          </text>
        </g>
      ))}
      {series.map((p, i) => (
        <rect key={p.date} x={x(i) - Math.min(14, band * 0.35)} width={Math.min(28, band * 0.7)} y={H - padB - barH(p.n)} height={barH(p.n)} fill="var(--accent-soft)" rx="2">
          <title>{`${label(p.date)}: ${p.n} response${p.n === 1 ? "" : "s"}${p.overallAvg === null ? "" : `, average ${p.overallAvg}`}`}</title>
        </rect>
      ))}
      {segments.map((d) => (
        <path key={d} d={d} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {series.map((p, i) =>
        p.overallAvg !== null && (markers || isolated(series, i)) ? <circle key={`m-${p.date}`} cx={x(i)} cy={yAvg(p.overallAvg)} r="4" fill="var(--accent)" /> : null,
      )}
      {labelIndexes.map((i) => (
        <text key={`l-${i}`} x={x(i)} y={H - 6} textAnchor="middle" fill="var(--faint)" fontSize="11">
          {label(series[i]!.date)}
        </text>
      ))}
    </svg>
  );
}

/** A point with no drawn neighbour would otherwise be invisible (a one-point path). */
function isolated(series: SurveySeriesPoint[], i: number): boolean {
  return (series[i - 1]?.overallAvg ?? null) === null && (series[i + 1]?.overallAvg ?? null) === null;
}

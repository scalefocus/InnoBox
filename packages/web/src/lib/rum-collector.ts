// The §14.12 collector's engine (INNOBOX_SPEC.md): the per-tab session, the view buffer, the API
// call filter and the batch builder. No DOM access — the browser APIs are wired up by
// components/RumCollector.tsx — so the whole of it runs under the unit runner.
//
// The life of a view: it starts on a hard load or a route change, collects interactions, API
// calls and errors while it is the current view, and ends at the next route change. An ended view
// waits in the queue and is serialized only when a batch is taken, so an API call that resolves
// after its view ended still lands on it. The hard-load view is the exception: it is HELD until
// the page is hidden, because its CLS (and a late LCP) are only final then.
import {
  RUM_FLUSH_SCHEDULE_S,
  RUM_MAX_API_TIMINGS,
  RUM_MAX_BEACON_BYTES,
  RUM_MAX_ERRORS_PER_BEACON,
  RUM_MAX_ERRORS_PER_VIEW,
  RUM_MAX_VIEWS_PER_BEACON,
  decideSampled,
  inpFromInteractions,
  nextFlushStep,
} from "@innobox/shared/rum";

// ── Session ──────────────────────────────────────────────────────────────────────────────

export const RUM_SESSION_KEY = "innobox:rum-session";

export interface RumSession {
  sid: string;
  sampled: boolean;
}

/** Minimal Storage surface, so tests can pass a Map-backed fake. */
export interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The tab's session: read from sessionStorage, or — the first time the collector starts in this
 * tab — a fresh random id with ONE sampling draw, stored together so a reload, an in-tab
 * navigation or a later rate change never re-draws. Without storage (blocked, private mode) the
 * session lives for this page only.
 */
export function loadOrStartSession(store: SessionStore | null, rate: number, random: () => number, uuid: () => string): RumSession {
  try {
    const raw = store?.getItem(RUM_SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RumSession>;
      if (typeof parsed.sid === "string" && typeof parsed.sampled === "boolean") return { sid: parsed.sid, sampled: parsed.sampled };
    }
  } catch {
    /* unreadable — start a new one */
  }
  const session = { sid: uuid(), sampled: decideSampled(rate, random()) };
  try {
    store?.setItem(RUM_SESSION_KEY, JSON.stringify(session));
  } catch {
    /* quota or blocked — this page keeps the session in memory */
  }
  return session;
}

// ── Which requests are the page's work ───────────────────────────────────────────────────

/** The shell's 30-second pulse (§12.2 — the bell count, the badges and the banner in one poll) is
 *  not the page's work (the §14.5 rule), nor are the two pollers it replaced, should anything still
 *  call them; the beacon is not, and neither is the auth library's session check. Opening the
 *  bell's inbox list is a person acting, and counts. */
export function isTrackedApiCall(url: string, method: string, origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return false;
  }
  if (parsed.origin !== origin) return false;
  const path = parsed.pathname;
  if (path !== "/api" && !path.startsWith("/api/")) return false;
  if (path === "/api/rum" || path.startsWith("/api/auth/")) return false;
  const read = method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD";
  if (read && (path === "/api/me/pulse" || path === "/api/admin/triage/attention" || path === "/api/challenges/new-count")) return false;
  return true;
}

/** How a tracked call ended: a status ≥ 500, a network failure or the app's own timeout is an
 *  error; a request the browser cancelled because the user moved on is neither a call nor an
 *  error; everything else (4xx included — the app saying no) is a plain call. */
export type ApiOutcome = "ok" | "error" | "cancelled";

export function apiOutcomeOfStatus(status: number): ApiOutcome {
  return status >= 500 ? "error" : "ok";
}

export function apiOutcomeOfThrow(err: unknown): ApiOutcome {
  const name = err && typeof err === "object" ? (err as { name?: unknown }).name : undefined;
  return name === "AbortError" ? "cancelled" : "error";
}

// ── Views and the buffer ─────────────────────────────────────────────────────────────────

export interface ViewState {
  route: string;
  day: string;
  hard: boolean;
  navMs: number | null;
  interactions: Map<number, number>;
  apiMs: number[];
  calls: number;
  apiErrors: number;
  errors: number;
  described: number;
  /** Sent open on a hide; later changes are not sent again. */
  sent: boolean;
}

export interface HardLoadMetrics {
  lcp: number | null;
  cls: number | null;
  ttfb: number | null;
}

export interface WireView {
  route: string;
  day: string;
  hard: boolean;
  lcp: number | null;
  inp: number | null;
  cls: number | null;
  ttfb: number | null;
  nav: number | null;
  api: number[];
  calls: number;
  apiErrors: number;
  errors: number;
}

export interface WireError {
  message: string;
  source: string;
  frame: string;
  route: string;
}

export interface Batch {
  views: ViewState[];
  errors: WireError[];
  body: string;
}

export class RumBuffer {
  private queue: ViewState[] = [];
  private held: ViewState | null = null;
  private errors: WireError[] = [];
  private current: ViewState | null = null;
  readonly hardMetrics: HardLoadMetrics = { lcp: null, cls: null, ttfb: null };

  constructor(private readonly sid: string) {}

  get currentView(): ViewState | null {
    return this.current;
  }

  startView(route: string, day: string, hard: boolean, navMs: number | null = null): ViewState {
    this.endView();
    this.current = { route, day, hard, navMs, interactions: new Map(), apiMs: [], calls: 0, apiErrors: 0, errors: 0, described: 0, sent: false };
    return this.current;
  }

  /** Ends the current view: the hard-load view is held for the hide, any other is queued. */
  endView(): void {
    const view = this.current;
    this.current = null;
    if (!view || view.sent) return;
    if (view.hard) this.held = view;
    else this.queue.push(view);
  }

  /** An interaction's longest event duration, kept per interaction id on the current view. */
  recordInteraction(interactionId: number, duration: number): void {
    const view = this.current;
    if (!view || interactionId <= 0) return;
    view.interactions.set(interactionId, Math.max(view.interactions.get(interactionId) ?? 0, duration));
  }

  /** A finished API call, attributed to the view that was current when it STARTED. */
  recordApi(view: ViewState | null, ms: number, outcome: ApiOutcome): void {
    if (!view || outcome === "cancelled") return;
    view.calls += 1;
    if (view.apiMs.length < RUM_MAX_API_TIMINGS) view.apiMs.push(Math.max(0, Math.round(ms)));
    if (outcome === "error") view.apiErrors += 1;
  }

  /** An error occurrence on the current view: always counted, described only up to 10 per view. */
  recordError(desc: { message: string; source: string; frame: string }): void {
    const view = this.current;
    if (!view) return;
    view.errors += 1;
    if (view.described >= RUM_MAX_ERRORS_PER_VIEW) return;
    view.described += 1;
    this.errors.push({ ...desc, route: view.route });
  }

  serialize(view: ViewState): WireView {
    const hard = view.hard;
    return {
      route: view.route,
      day: view.day,
      hard,
      lcp: hard ? this.hardMetrics.lcp : null,
      inp: inpFromInteractions([...view.interactions.values()]),
      cls: hard ? this.hardMetrics.cls : null,
      ttfb: hard ? this.hardMetrics.ttfb : null,
      nav: view.navMs,
      api: view.apiMs,
      calls: view.calls,
      apiErrors: view.apiErrors,
      errors: view.errors,
    };
  }

  /**
   * The next beacon, or null when there is nothing to send. A regular tick sends completed views
   * only; the final flush on hide also sends the held hard-load view and the current view (open,
   * marked so it is not sent twice). At most 50 views, 50 errors and 64 KB — the rest wait.
   */
  takeBatch(final: boolean): Batch | null {
    const views = [...this.queue];
    if (final) {
      if (this.held) views.push(this.held);
      if (this.current && !this.current.sent) views.push(this.current);
    }
    let pickViews = views.slice(0, RUM_MAX_VIEWS_PER_BEACON);
    let pickErrors = this.errors.slice(0, RUM_MAX_ERRORS_PER_BEACON);
    if (pickViews.length === 0 && pickErrors.length === 0) return null;

    const encode = () => JSON.stringify({ sid: this.sid, views: pickViews.map((v) => this.serialize(v)), errors: pickErrors });
    let body = encode();
    while (new TextEncoder().encode(body).length > RUM_MAX_BEACON_BYTES && pickViews.length + pickErrors.length > 1) {
      if (pickErrors.length >= pickViews.length) pickErrors = pickErrors.slice(0, -1);
      else pickViews = pickViews.slice(0, -1);
      body = encode();
    }

    const taken = new Set(pickViews);
    this.queue = this.queue.filter((v) => !taken.has(v));
    if (this.held && taken.has(this.held)) this.held = null;
    if (this.current && taken.has(this.current)) this.current.sent = true;
    this.errors = this.errors.slice(pickErrors.length);
    return { views: pickViews, errors: pickErrors, body };
  }

  /** Puts a batch that could not be sent back at the front, unless it held the open current view
   *  (a final flush is not retried). */
  requeue(batch: Batch): void {
    const back = batch.views.filter((v) => v !== this.current && !v.hard);
    this.queue = [...back, ...this.queue];
    const hard = batch.views.find((v) => v.hard && v !== this.current);
    if (hard && !this.held) this.held = hard;
    this.errors = [...batch.errors, ...this.errors];
  }
}

// ── The flush clock ──────────────────────────────────────────────────────────────────────

/** The schedule walker: `delayMs` for the next tick, and `after(sent)` to advance it. */
export class FlushClock {
  private step = 0;

  get delayMs(): number {
    return RUM_FLUSH_SCHEDULE_S[this.step]! * 1000;
  }

  after(sentSomething: boolean): void {
    this.step = nextFlushStep(this.step, sentSomething);
  }
}

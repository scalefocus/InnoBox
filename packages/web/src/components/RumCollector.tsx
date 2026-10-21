"use client";
// The §14.12 real-user-monitoring collector (INNOBOX_SPEC.md). Mounted by the authenticated app
// shell and nowhere else — the signed-out Home, the public form and the agent routes never load
// it. It renders nothing and does nothing unless collection is on, this tab's session is sampled
// and the browser has the APIs it needs; it never throws into the page.
//
// What it wires up (the engine, lib/rum-collector.ts, holds the state and builds the batches):
//   • Views — a hard load, then every route change (usePathname), each named by its registry
//     template before anything is recorded: no concrete path, number or title leaves the browser.
//   • Hard-load vitals — LCP, CLS and TTFB through the `web-vitals` library.
//   • INP — per view, from `event` timing entries grouped by interaction id.
//   • Navigation time — hard load: navigation start → DOMContentLoaded end; soft: the click,
//     history push or back/forward that started it → the first paint of the new route.
//   • API — a wrapper around window.fetch timing same-origin /api calls, pollers excluded.
//   • Errors — `error` and `unhandledrejection`, described by the shared rules (extensions,
//     foreign scripts and the ResizeObserver notice dropped; never DOM or form content).
//   • Flushes — on the backing-off schedule, and immediately when the page is hidden.
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { utcCalendarDay } from "@innobox/shared/calendar-day";
import { describeClientError, describeRejection, rumRouteFor } from "@innobox/shared/rum";
import {
  FlushClock,
  RumBuffer,
  apiOutcomeOfStatus,
  apiOutcomeOfThrow,
  isTrackedApiCall,
  loadOrStartSession,
} from "@/lib/rum-collector";

export interface RumConfig {
  enabled: boolean;
  sampleRate: number;
}

const BEACON_URL = "/api/rum";
/** A click or history push older than this did not start the route change being measured. */
const NAV_START_MAX_AGE_MS = 10_000;

function quietly(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.debug("rum collector", err);
  }
}

function browserSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof PerformanceObserver === "function" &&
    typeof navigator.sendBeacon === "function" &&
    typeof crypto?.randomUUID === "function"
  );
}

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function RumCollector({ config }: { config: RumConfig | null | undefined }) {
  const pathname = usePathname();
  const bufferRef = useRef<RumBuffer | null>(null);
  const navStartRef = useRef<number | null>(null);
  const firstViewRef = useRef(true);

  const active = Boolean(config?.enabled);
  const rate = config?.sampleRate ?? 100;

  // Start the collector once per page load (and stop it if the shell unmounts).
  useEffect(() => {
    if (!active || !browserSupported()) return;
    let buffer: RumBuffer;
    try {
      const session = loadOrStartSession(sessionStore(), rate, Math.random, () => crypto.randomUUID());
      if (!session.sampled) return;
      buffer = new RumBuffer(session.sid);
    } catch {
      return;
    }
    bufferRef.current = buffer;
    const origin = window.location.origin;
    const cleanups: (() => void)[] = [];

    // Hard-load vitals. reportAllChanges keeps the values current, so whatever the hide sends is
    // the latest; the hard-load view waits for that hide (see the engine).
    void import("web-vitals")
      .then(({ onLCP, onCLS, onTTFB }) => {
        if (bufferRef.current !== buffer) return;
        onLCP((m) => (buffer.hardMetrics.lcp = m.value), { reportAllChanges: true });
        onCLS((m) => (buffer.hardMetrics.cls = m.value), { reportAllChanges: true });
        onTTFB((m) => (buffer.hardMetrics.ttfb = m.value));
      })
      .catch(() => {});

    // INP per view: the longest event of each interaction, on the view current when it happened.
    quietly(() => {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as (PerformanceEntry & { interactionId?: number })[]) {
          if (entry.interactionId) buffer.recordInteraction(entry.interactionId, entry.duration);
        }
      });
      observer.observe({ type: "event", buffered: true, durationThreshold: 40 } as PerformanceObserverInit);
      cleanups.push(() => observer.disconnect());
    });

    // What started a soft navigation: an internal link click, a history push, or back/forward.
    const markNavStart = () => (navStartRef.current = performance.now());
    const onClick = (e: MouseEvent) =>
      quietly(() => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const link = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
        if (link && link.origin === origin && link.target !== "_blank") markNavStart();
      });
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", markNavStart);
    const originalPush = history.pushState;
    history.pushState = function (...args: Parameters<History["pushState"]>) {
      const started = navStartRef.current;
      if (started === null || performance.now() - started > NAV_START_MAX_AGE_MS) markNavStart();
      return originalPush.apply(this, args);
    };
    cleanups.push(() => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", markNavStart);
      if (history.pushState !== originalPush) history.pushState = originalPush;
    });

    // API calls: same-origin /api work of the page, timed through a fetch wrapper.
    const originalFetch = window.fetch;
    const wrappedFetch: typeof fetch = async (input, init) => {
      let tracked = false;
      try {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        tracked = isTrackedApiCall(url, method, origin);
      } catch {
        tracked = false;
      }
      if (!tracked) return originalFetch(input, init);
      const view = buffer.currentView;
      const started = performance.now();
      try {
        const res = await originalFetch(input, init);
        quietly(() => buffer.recordApi(view, performance.now() - started, apiOutcomeOfStatus(res.status)));
        return res;
      } catch (err) {
        quietly(() => buffer.recordApi(view, performance.now() - started, apiOutcomeOfThrow(err)));
        throw err;
      }
    };
    window.fetch = wrappedFetch;
    cleanups.push(() => {
      if (window.fetch === wrappedFetch) window.fetch = originalFetch;
    });

    // Errors.
    const onError = (e: ErrorEvent) =>
      quietly(() => {
        const desc = describeClientError({ message: e.message, filename: e.filename, lineno: e.lineno, stack: e.error?.stack }, origin);
        if (desc) buffer.recordError(desc);
      });
    const onRejection = (e: PromiseRejectionEvent) =>
      quietly(() => {
        const desc = describeRejection(e.reason, origin);
        if (desc) buffer.recordError(desc);
      });
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    cleanups.push(() => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    });

    // Flushing.
    const clock = new FlushClock();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = (final: boolean): boolean => {
      const batch = buffer.takeBatch(final);
      if (!batch) return false;
      let ok = false;
      try {
        ok = navigator.sendBeacon(BEACON_URL, batch.body);
      } catch {
        ok = false;
      }
      if (!ok && !final) buffer.requeue(batch);
      return ok;
    };
    const tick = () => {
      quietly(() => clock.after(send(false)));
      timer = setTimeout(tick, clock.delayMs);
    };
    timer = setTimeout(tick, clock.delayMs);
    const onHide = () => quietly(() => void send(true));
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onHide);
    cleanups.push(() => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onHide);
    });

    return () => {
      for (const fn of cleanups) quietly(fn);
      if (bufferRef.current === buffer) bufferRef.current = null;
    };
  }, [active, rate]);

  // Views: the first one is the hard load, every later pathname a soft navigation.
  useEffect(() => {
    const buffer = bufferRef.current;
    if (!buffer) return;
    quietly(() => {
      const route = rumRouteFor(pathname ?? "/");
      const day = utcCalendarDay(Date.now());
      if (firstViewRef.current) {
        firstViewRef.current = false;
        const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
        const navMs = nav && nav.domContentLoadedEventEnd > 0 ? nav.domContentLoadedEventEnd : null;
        buffer.startView(route, day, true, navMs);
        return;
      }
      const started = navStartRef.current;
      navStartRef.current = null;
      const view = buffer.startView(route, day, false);
      if (started === null || performance.now() - started > NAV_START_MAX_AGE_MS) return;
      // The new route has committed; the frame after the next paint is when the person saw it.
      requestAnimationFrame(() => setTimeout(() => (view.navMs = Math.round(performance.now() - started)), 0));
    });
    // `active` re-runs this once the collector has started, so the first view is recorded.
  }, [pathname, active]);

  return null;
}

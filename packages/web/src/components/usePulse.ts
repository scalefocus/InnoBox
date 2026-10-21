"use client";
// The §12.2 pulse poller (INNOBOX_SPEC.md §12.2, v1.18): ONE request per tab, every 30 s while the
// tab is visible and never while it is hidden; a tab that comes back polls at once when its last
// pulse is stale, then resumes the cadence. The window events in PULSE_REFRESH_EVENTS re-read it
// immediately. An unchanged pulse keeps the previous state object, so an idle tick re-renders
// nothing. A 401 ends the session: polling stops.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  EMPTY_PULSE,
  PULSE_INTERVAL_MS,
  PULSE_REFRESH_EVENTS,
  parsePulse,
  pulseOutcome,
  samePulse,
  shouldPollOnVisible,
  type Pulse,
} from "../lib/pulse";

export interface PulseControls {
  pulse: Pulse;
  /** The bell's list response carries the unread count too; the shell adopts it (§12.2). */
  adoptUnreadCount: (unreadCount: number) => void;
}

export function usePulse(enabled: boolean): PulseControls {
  const [pulse, setPulse] = useState<Pulse>(EMPTY_PULSE);
  const lastAt = useRef<number | null>(null);
  const stopped = useRef(false);
  const inFlight = useRef(false);

  const apply = useCallback((next: Pulse) => {
    setPulse((prev) => (samePulse(prev, next) ? prev : next));
  }, []);

  const adoptUnreadCount = useCallback((unreadCount: number) => {
    setPulse((prev) => (prev.unreadCount === unreadCount ? prev : { ...prev, unreadCount }));
  }, []);

  useEffect(() => {
    if (!enabled) {
      lastAt.current = null;
      return;
    }
    stopped.current = false;
    let live = true;
    let timer: number | null = null;

    const poll = async () => {
      if (!live || stopped.current || inFlight.current) return;
      if (document.visibilityState === "hidden") return;
      inFlight.current = true;
      try {
        const res = await fetch("/api/me/pulse", { headers: { accept: "application/json" }, cache: "no-store" });
        const outcome = pulseOutcome(res.status);
        if (outcome === "stop") stopped.current = true;
        if (outcome === "apply" && live) {
          apply(parsePulse(await res.json()));
          lastAt.current = Date.now();
        }
      } catch {
        /* network blip: keep the last values, retry on the next tick */
      } finally {
        inFlight.current = false;
      }
    };

    const start = () => {
      if (timer === null) timer = window.setInterval(() => void poll(), PULSE_INTERVAL_MS);
    };
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        stop();
        return;
      }
      if (shouldPollOnVisible(lastAt.current, Date.now())) void poll();
      start();
    };
    const onRefresh = () => void poll();

    if (document.visibilityState !== "hidden") {
      void poll();
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);
    for (const name of PULSE_REFRESH_EVENTS) window.addEventListener(name, onRefresh);
    return () => {
      live = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      for (const name of PULSE_REFRESH_EVENTS) window.removeEventListener(name, onRefresh);
    };
  }, [enabled, apply]);

  // Signed out (or not yet signed in): nothing to show, whatever an earlier session left in state.
  return { pulse: enabled ? pulse : EMPTY_PULSE, adoptUnreadCount };
}

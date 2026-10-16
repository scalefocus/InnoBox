"use client";
// The shared chart wrapper (INNOBOX_SPEC.md §14.5 "The chart wrapper (shared)") — both admin
// charts, the Currently online active-users chart and the survey satisfaction trend, render
// through this component on Apache ECharts.
//
// What it owns, so no chart can get it wrong on its own:
//   • Lazy loading. ECharts arrives through a dynamic import of ./echarts-modules on first
//     mount, so only the Administration console downloads it.
//   • Brand tokens, resolved. ECharts derives hover and emphasis shades from a colour value and
//     cannot take `var(--accent)`, so the tokens are read with getComputedStyle and handed to
//     the chart's option builder — and re-read whenever <html data-theme> flips at runtime.
//   • UTC. `useUTC: true` is forced on every option: the axes are UTC days, and ECharts would
//     otherwise format and place them in the viewer's zone.
//   • Accessibility and motion. Aria is always on, with each builder's own one-sentence
//     summary as the description (ECharts' generated text reads raw axis values aloud); the
//     title — registered, never drawn — is the fallback. Animation is off under
//     prefers-reduced-motion.
//   • Lifecycle. Resizes with its container; disposed on unmount.
//
// The option builders (lib/charts/*) are pure; this file is the only one that touches the DOM.
import { useEffect, useRef, useState } from "react";
import type { ECharts, EChartsCoreOption } from "echarts/core";
import { CHART_TOKEN_VARS, type ChartEnv, type ChartTokens } from "@/lib/charts/chart-env";

function readTokens(): ChartTokens {
  const css = getComputedStyle(document.documentElement);
  const tokens = {} as ChartTokens;
  for (const [key, cssVar] of Object.entries(CHART_TOKEN_VARS) as [keyof ChartTokens, string][]) {
    tokens[key] = css.getPropertyValue(cssVar).trim();
  }
  return tokens;
}

function matches(query: string): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

export interface EChartProps {
  /** Builds the option from the resolved environment. Memoize it: a new identity re-applies. */
  build: (env: ChartEnv) => EChartsCoreOption;
  /** What the chart shows, for the generated aria description. Never drawn. */
  title: string;
  height: number;
  className?: string;
  testId?: string;
  /** A user zoom (slider, drag, Ctrl+wheel). Options applied by `build` never fire it. */
  onDataZoom?: (params: unknown) => void;
}

export function EChart({ build, title, height, className, testId, onDataZoom }: EChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const [ready, setReady] = useState(false);
  const [themeTick, setThemeTick] = useState(0);
  // Coarsened so a window drag re-applies the option a handful of times, not on every pixel.
  const [width, setWidth] = useState(0);

  // Latest-callback ref, synced in an effect, so the listener bound at init never goes stale.
  const zoomHandler = useRef(onDataZoom);
  useEffect(() => {
    zoomHandler.current = onDataZoom;
  }, [onDataZoom]);

  useEffect(() => {
    let disposed = false;
    let resize: ResizeObserver | undefined;
    let theme: MutationObserver | undefined;
    void import("./echarts-modules").then(({ echarts }) => {
      const el = host.current;
      if (disposed || !el) return;
      const instance = echarts.init(el, null, { renderer: "canvas" });
      chart.current = instance;
      instance.on("datazoom", (params: unknown) => zoomHandler.current?.(params));
      const measure = () => setWidth(Math.round(el.clientWidth / 40) * 40);
      measure();
      resize = new ResizeObserver(() => {
        instance.resize();
        measure();
      });
      resize.observe(el);
      theme = new MutationObserver(() => setThemeTick((t) => t + 1));
      theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      setReady(true);
    });
    return () => {
      disposed = true;
      resize?.disconnect();
      theme?.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = chart.current;
    if (!ready || !instance) return;
    const env: ChartEnv = { tokens: readTokens(), coarsePointer: matches("(pointer: coarse)"), width };
    const built = build(env) as EChartsCoreOption & { aria?: Record<string, unknown> };
    // Merge mode, not notMerge: a legend selection or a dragged zoom survives a theme flip.
    instance.setOption({
      textStyle: { fontFamily: env.tokens.fontBody },
      ...built,
      title: { text: title, show: false },
      // Always on; a builder's own summary (aria.label.description) replaces the generated one.
      aria: { ...built.aria, enabled: true },
      useUTC: true,
      animation: !matches("(prefers-reduced-motion: reduce)"),
    });
  }, [ready, build, title, themeTick, width]);

  // role="img" + a fallback label until ECharts writes its generated description over it.
  return <div ref={host} className={className} style={{ height }} role="img" aria-label={title} data-testid={testId} />;
}

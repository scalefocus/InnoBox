// The ECharts build InnoBox ships (INNOBOX_SPEC.md §14.5 "The chart wrapper"): exactly the
// modules the two admin charts use, registered once. Only components/EChart.tsx imports this
// file, and only through a dynamic import(), so it lands in its own chunk that the
// Administration console downloads on first chart mount — no other page pays for it.
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import {
  AriaComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  AriaComponent,
  // Registered for the aria description only — each chart's title is set with `show: false`.
  TitleComponent,
  CanvasRenderer,
]);

export { echarts };

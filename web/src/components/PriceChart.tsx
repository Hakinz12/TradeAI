import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, createChart, createSeriesMarkers, CrosshairMode } from "lightweight-charts";
import type { IChartApi, IPriceLine, ISeriesApi, SeriesMarker, Time, UTCTimestamp } from "lightweight-charts";
import type { Candle } from "../../../src/types";
import type { ExitLevels } from "../../../src/api-types";
import { LOCALE } from "../format";

export interface ChartMarker {
  /** Unix seconds */
  time: number;
  kind: "entry" | "exit";
  text: string;
  good?: boolean;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const precisionFor = (p: number) => (p <= 0 ? 6 : Math.min(12, Math.max(4, Math.ceil(-Math.log10(p)) + 3)));

export function PriceChart({ candles, markers, levels, stepSec }: { candles: Candle[]; markers: ChartMarker[]; levels: ExitLevels | null; stepSec: number }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markerApi = useRef<ReturnType<typeof createSeriesMarkers<Time>> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const fitted = useRef(false);

  useEffect(() => {
    if (!host.current) return;
    const c = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css("--muted"), fontFamily: css("--mono") },
      grid: { vertLines: { color: css("--line") }, horzLines: { color: css("--line") } },
      rightPriceScale: { borderColor: css("--line") },
      timeScale: { borderColor: css("--line"), timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { locale: LOCALE },
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: css("--green"), downColor: css("--red"), borderUpColor: css("--green"), borderDownColor: css("--red"), wickUpColor: css("--green"), wickDownColor: css("--red"),
    });
    chart.current = c;
    series.current = s;
    markerApi.current = createSeriesMarkers(s, []);
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
      markerApi.current = null;
      lines.current = [];
      fitted.current = false;
    };
  }, []);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const last = candles[candles.length - 1];
    if (last) {
      const p = precisionFor(last.close);
      s.applyOptions({ priceFormat: { type: "price", precision: p, minMove: 10 ** -p } });
    }
    s.setData(candles.map((k) => ({ time: k.time as UTCTimestamp, open: k.open, high: k.high, low: k.low, close: k.close })));
    if (candles.length && !fitted.current) {
      chart.current?.timeScale().fitContent();
      fitted.current = true;
    }
  }, [candles]);

  useEffect(() => {
    if (!markerApi.current) return;
    const snap = (t: number) => Math.floor(t / Math.max(stepSec, 1)) * Math.max(stepSec, 1);
    const first = candles[0]?.time ?? 0;
    const lastT = candles[candles.length - 1]?.time ?? 0;
    const ms: SeriesMarker<Time>[] = markers
      .filter((m) => snap(m.time) >= first && snap(m.time) <= lastT)
      .sort((a, b) => a.time - b.time)
      .map((m) => ({
        time: snap(m.time) as UTCTimestamp,
        position: m.kind === "entry" ? "belowBar" : "aboveBar",
        shape: m.kind === "entry" ? "arrowUp" : "arrowDown",
        color: m.kind === "entry" ? css("--accent") : m.good ? css("--green") : css("--red"),
        text: m.text,
      }));
    markerApi.current.setMarkers(ms);
  }, [markers, candles, stepSec]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const l of lines.current) s.removePriceLine(l);
    lines.current = [];
    if (!levels) return;
    const add = (price: number | null, title: string, color: string) => {
      if (price && price > 0) lines.current.push(s.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title }));
    };
    add(levels.entry, "entry", css("--blue"));
    add(levels.stop, "stop", css("--red"));
    add(levels.tp1, "TP1", css("--green"));
    add(levels.takeProfit, "TP", css("--green"));
    add(levels.trail, "trail", css("--amber"));
  }, [levels]);

  return <div ref={host} style={{ position: "absolute", inset: 0 }} />;
}

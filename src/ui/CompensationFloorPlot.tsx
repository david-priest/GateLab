// CompensationFloorPlot.tsx — one pair as the compensation screen read it.
//
// Source signal across, receiver up, both on the arcsinh scale mass cytometry is drawn on. Over
// the events: the receiver's floor in each group of events (the points the slope was fitted
// through), the line the matrix's coefficient gives, and the line of the largest coefficient the
// events allow. Where the matrix's line runs above the floor of the bright events, the matrix
// takes off more than the events hold; where the floor climbs away from it, less.
import { useMemo } from "react";
import type { ScreenPair } from "../compensationScreen/screenPairs";
import { useI18n } from "./i18n";

const WIDTH = 300;
const HEIGHT = 230;
const MARGIN = { left: 38, right: 8, top: 8, bottom: 30 } as const;
const COFACTOR = 5;
/** Events drawn: every bright one up to a cap, and a thinned sample of the rest. */
const MAX_BRIGHT_POINTS = 3_500;
const MAX_DIM_POINTS = 1_500;
const TICKS = [0, 10, 100, 1_000, 10_000, 100_000] as const;

const scaled = (value: number) => Math.asinh(value / COFACTOR);

function tickLabel(value: number): string {
  if (value >= 1_000) return `${value / 1_000}k`;
  return String(value);
}

export interface CompensationFloorPlotProps {
  readonly pair: ScreenPair;
  /** The pair's events as the screen fitted them (screenPairEvents). */
  readonly events: Readonly<{ source: ArrayLike<number>; receiver: ArrayLike<number> }>;
  readonly sourceLabel: string;
  readonly receiverLabel: string;
}

export function CompensationFloorPlot({ pair, events, sourceLabel, receiverLabel }: CompensationFloorPlotProps) {
  const { t } = useI18n();
  const floor = pair.floor;
  const drawing = useMemo(() => {
    if (!floor) return null;
    const count = events.source.length;
    // The lower half of the source carries no information about the slope: thin it hard.
    const brightFrom = floor.points[1]?.source ?? 0;
    const bright: number[] = [];
    const dim: number[] = [];
    for (let event = 0; event < count; event++) (events.source[event] > brightFrom ? bright : dim).push(event);
    const thin = (list: number[], cap: number) =>
      list.length <= cap ? list : Array.from({ length: cap }, (_, index) => list[Math.floor(index * list.length / cap)]);
    const shown = [...thin(dim, MAX_DIM_POINTS), ...thin(bright, MAX_BRIGHT_POINTS)];

    const top = floor.points[floor.points.length - 1];
    const xMaximum = scaled(Math.max(20, top.source * 4));
    let yHigh = Math.max(20, top.floor * 4, pair.coefficient * top.source * 2);
    const receiverValues = shown.map((event) => events.receiver[event]).sort((left, right) => left - right);
    yHigh = Math.max(yHigh, receiverValues[Math.floor(receiverValues.length * 0.98)] ?? 0);
    const yMinimum = scaled(Math.min(0, receiverValues[Math.floor(receiverValues.length * 0.005)] ?? 0));
    const yMaximum = scaled(yHigh);
    const innerWidth = WIDTH - MARGIN.left - MARGIN.right;
    const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
    const px = (value: number) => MARGIN.left + Math.max(0, Math.min(1, scaled(value) / xMaximum)) * innerWidth;
    const py = (value: number) =>
      MARGIN.top + (1 - Math.max(0, Math.min(1, (scaled(value) - yMinimum) / (yMaximum - yMinimum)))) * innerHeight;

    const points = shown
      .map((event) => `M${px(events.source[event]).toFixed(1)} ${py(events.receiver[event]).toFixed(1)}h0`)
      .join("");
    // A line of slope `coefficient` through the reference group's floor, drawn as the curve it is on this scale.
    const reference = floor.points[0];
    const line = (coefficient: number) => {
      const steps = 48;
      let path = "";
      for (let step = 0; step <= steps; step++) {
        const x = COFACTOR * Math.sinh(xMaximum * step / steps);
        const y = reference.floor + coefficient * (x - reference.source);
        path += `${step === 0 ? "M" : "L"}${px(x).toFixed(1)} ${py(y).toFixed(1)}`;
      }
      return path;
    };
    return {
      points,
      matrixLine: line(pair.coefficient),
      boundLine: line(floor.upperBound),
      floors: floor.points.map((point) => ({ x: px(point.source), y: py(point.floor) })),
      xTicks: TICKS.filter((tick) => scaled(tick) <= xMaximum).map((tick) => ({ tick, at: px(tick) })),
      yTicks: TICKS.filter((tick) => scaled(tick) <= yMaximum).map((tick) => ({ tick, at: py(tick) })),
    };
  }, [events, floor, pair.coefficient]);

  if (!floor || !drawing) return null;
  const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
  return (
    <figure className="gl-comp-floor-plot">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={t("Receiver floor against source signal for {source} to {receiver}: matrix {matrix}, events allow at most {bound}", {
          source: sourceLabel,
          receiver: receiverLabel,
          matrix: percent(pair.coefficient),
          bound: percent(floor.upperBound),
        })}
      >
        <rect
          className="gl-comp-floor-frame"
          x={MARGIN.left}
          y={MARGIN.top}
          width={WIDTH - MARGIN.left - MARGIN.right}
          height={HEIGHT - MARGIN.top - MARGIN.bottom}
        />
        <path className="gl-comp-floor-events" d={drawing.points} />
        <path className="gl-comp-floor-bound" d={drawing.boundLine} />
        <path className="gl-comp-floor-matrix" d={drawing.matrixLine} />
        {drawing.floors.map((point, index) => (
          <circle className="gl-comp-floor-point" cx={point.x} cy={point.y} r={3} key={index} />
        ))}
        {drawing.xTicks.map(({ tick, at }) => (
          <text className="gl-comp-floor-tick" x={at} y={HEIGHT - MARGIN.bottom + 11} textAnchor="middle" key={`x${tick}`}>{tickLabel(tick)}</text>
        ))}
        {drawing.yTicks.map(({ tick, at }) => (
          <text className="gl-comp-floor-tick" x={MARGIN.left - 4} y={at + 3} textAnchor="end" key={`y${tick}`}>{tickLabel(tick)}</text>
        ))}
        <text className="gl-comp-floor-axis" x={MARGIN.left + (WIDTH - MARGIN.left - MARGIN.right) / 2} y={HEIGHT - 4} textAnchor="middle">
          {t("{channel} (counts)", { channel: sourceLabel })}
        </text>
        <text className="gl-comp-floor-axis" transform={`translate(9 ${MARGIN.top + (HEIGHT - MARGIN.top - MARGIN.bottom) / 2}) rotate(-90)`} textAnchor="middle">
          {t("{channel} (counts)", { channel: receiverLabel })}
        </text>
      </svg>
      <figcaption>
        <span><i className="is-point" aria-hidden="true" />{t("Receiver floor per group of events")}</span>
        <span><i className="is-matrix" aria-hidden="true" />{t("Matrix {value}", { value: percent(pair.coefficient) })}</span>
        <span><i className="is-bound" aria-hidden="true" />{t("Most the events allow {value}", { value: percent(floor.upperBound) })}</span>
      </figcaption>
    </figure>
  );
}

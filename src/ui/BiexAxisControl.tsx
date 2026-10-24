// BiexAxisControl.tsx — the Transforms row's control for a fluorescence axis shown on FlowJo's
// biexponential: the width basis on a slider, as the logicle W is, and FlowJo's other parameters
// behind a menu beside it, where an import's recorded values are kept and can be returned to, or
// the default axis (Sample.defaultBiex) where nothing was recorded.
//
// Display only, as every flow scale choice: a flow gate is held in raw values, or in its own
// stored transform for an imported FlowJo gate, so changing the axis moves no gate and no count.
// The parameters are FlowJo's (biex.ts): positive decades, extra negative decades, the negative
// width basis and the top of the scale. The output range, the table resolution and the spline
// choice are carried over unchanged; they say how the axis was recorded, not how it looks.

import { useEffect, useRef, useState } from "react";
import type { BiexParams } from "../engine/biex";
import { useI18n } from "./i18n";
import { NumberField } from "./NumberField";

/** The four parameters the popover adjusts. */
type BiexField = "pos" | "neg" | "widthBasis" | "maxValue";

const MINUS = "−";

/** A number to `digits` significant figures, as a number. */
const roundSig = (value: number, digits: number): number => Number(value.toPrecision(digits));

/** Decades (pos, neg): two decimals at most, trailing zeros dropped. */
export function formatBiexDecades(value: number): string {
  return String(Math.round(value * 100) / 100).replace("-", MINUS);
}

/** The width basis: one decimal at most, so −199.5262314969 reads −199.5. */
export function formatBiexWidth(value: number): string {
  return String(Math.round(value * 10) / 10).replace("-", MINUS);
}

/** The top of the scale in three significant figures: 3.16M, 262K. */
export function formatBiexMax(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${roundSig(value / 1e6, 3)}M`;
  if (abs >= 1e3) return `${roundSig(value / 1e3, 3)}K`;
  return String(roundSig(value, 3));
}

/** The four parameters in the order FlowJo's dialog gives them, short enough for the row. */
export function formatBiexSummary(p: BiexParams): string {
  return [formatBiexDecades(p.pos), formatBiexDecades(p.neg), formatBiexWidth(p.widthBasis), formatBiexMax(p.maxValue)].join(" · ");
}

/** Every parameter at full precision, for the tooltip. */
export function formatBiexFull(p: BiexParams): string {
  return `pos ${p.pos}, neg ${p.neg}, width ${p.widthBasis}, max ${p.maxValue.toLocaleString("en-US")}`;
}

const sameBiex = (a: BiexParams, b: BiexParams) =>
  a.pos === b.pos && a.neg === b.neg && a.widthBasis === b.widthBasis && a.maxValue === b.maxValue;

/**
 * Each slider and the value it stands for. Width and max run over log10 of their magnitude, as
 * the arcsinh cofactor does, because the values in use span decades. The width range stops where
 * biex.ts clamps it (10^0.5 to 10^3): beyond that the axis does not change.
 */
const SLIDERS: Record<BiexField, { min: number; max: number; step: number; toSlider: (v: number) => number; fromSlider: (s: number) => number }> = {
  pos: { min: 1, max: 7, step: 0.01, toSlider: (v) => v, fromSlider: (s) => Math.round(s * 100) / 100 },
  neg: { min: 0, max: 2, step: 0.01, toSlider: (v) => v, fromSlider: (s) => Math.round(s * 100) / 100 },
  widthBasis: { min: 0.5, max: 3, step: 0.01, toSlider: (v) => Math.log10(-v), fromSlider: (s) => -roundSig(Math.pow(10, s), 4) },
  maxValue: { min: 3, max: 7.5, step: 0.01, toSlider: (v) => Math.log10(v), fromSlider: (s) => roundSig(Math.pow(10, s), 3) },
};

/**
 * What each numeric entry shows, at the summary's precision: decades to two places, the width to
 * one, the top of the scale whole. Plain ASCII digits, as a number input needs. The parameter
 * underneath keeps every digit until a new value is typed (NumberField's format).
 */
const ENTRY_FORMAT: Record<BiexField, (value: number) => string> = {
  pos: (v) => String(Math.round(v * 100) / 100),
  neg: (v) => String(Math.round(v * 100) / 100),
  widthBasis: (v) => String(Math.round(v * 10) / 10),
  maxValue: (v) => String(Math.round(v)),
};

/** What the numeric entry accepts; the table itself refuses anything it cannot be built from. */
const ENTRY_BOUNDS: Record<BiexField, { min: number; max: number; step: number }> = {
  pos: { min: 0.1, max: 10, step: 0.1 },
  neg: { min: 0, max: 5, step: 0.1 },
  widthBasis: { min: -10000, max: -1, step: 1 },
  maxValue: { min: 1, max: 1e9, step: 1000 },
};

interface Props {
  axis: string;
  params: BiexParams;
  /** The parameters the object, file or import recorded, which Reset returns to. */
  recorded: BiexParams | null;
  /** The default axis for the channel (Sample.defaultBiex): Reset's target where nothing was recorded. */
  defaults?: BiexParams | null;
  /** Show the axis at these parameters; false when they cannot be shown. */
  onChange: (params: BiexParams) => boolean;
  onReset: () => void;
  /** A slider is held, and released: what is only needed once the axis settles can wait. */
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

export function BiexAxisControl({ axis, params, recorded, defaults = null, onChange, onReset, onDragStart, onDragEnd }: Props) {
  const { t } = useI18n();
  // A drag is echoed at once and applied once per frame, as the logicle W and the arcsinh
  // cofactor are: rebuilding the axis on every input event would stall the slider.
  const [pending, setPending] = useState<BiexParams | null>(null);
  const job = useRef<BiexParams | null>(null);
  const frame = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  const shown = pending ?? params;
  const change = (field: BiexField, value: number) => {
    const next = { ...shown, [field]: value };
    job.current = next;
    setPending(next);
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const target = job.current;
      job.current = null;
      if (target) onChangeRef.current(target);
      setPending(null);
    });
  };

  // Reset returns to what was recorded, or to the default axis where nothing was. A recording
  // equal to the default is named as the default, which it is.
  const target = recorded ?? defaults;
  const isDefault = !recorded || (!!defaults && sameBiex(recorded, defaults));
  const adjusted = !!target && !sameBiex(params, target);
  const labels: Record<BiexField, [string, string]> = {
    widthBasis: [t("Width basis"), t("Width basis (negative): the width of the linear region around zero. The further it is from zero, the wider that region and the more the values around zero are compressed.")],
    pos: [t("Positive decades"), t("Positive decades: how many decades the axis shows above the linear region.")],
    neg: [t("Extra negative decades"), `${t("Extra negative decades: room below zero. Raising it moves zero up the axis and every value with it, with little change in shape.")} ${t("A pan past either end of the axis shows space no event can fill, because an event beyond an end is drawn on it; room below zero for the data comes from the extra negative decades.")}`],
    maxValue: [t("Top of scale"), t("Top of scale: the raw value at the top of the axis.")],
  };
  const full = [
    t("Biexponential: {params}.", { params: formatBiexFull(params) }),
    adjusted && target
      ? isDefault
        ? t("Default: {params}.", { params: formatBiexFull(target) })
        : t("Recorded: {params}.", { params: formatBiexFull(target) })
      : null,
  ].filter(Boolean).join("\n");
  const slider = (field: BiexField, ariaLabel: string) => {
    const range = SLIDERS[field];
    return (
      <input
        type="range"
        aria-label={ariaLabel}
        title={labels[field][1]}
        min={range.min}
        max={range.max}
        step={range.step}
        value={Math.min(range.max, Math.max(range.min, range.toSlider(shown[field])))}
        onChange={(e) => change(field, range.fromSlider(+e.target.value))}
        onPointerDown={onDragStart}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        onLostPointerCapture={onDragEnd}
      />
    );
  };
  const entry = (field: BiexField) => (
    <NumberField
      aria-label={`${axis} biex ${field} value`}
      value={shown[field]}
      min={ENTRY_BOUNDS[field].min}
      max={ENTRY_BOUNDS[field].max}
      step={ENTRY_BOUNDS[field].step}
      format={ENTRY_FORMAT[field]}
      onCommit={(value) => change(field, value)}
    />
  );

  return (
    <>
      {slider("widthBasis", `${axis} biex widthBasis`)}
      <span className="gl-scale-val gl-biex-width" title={full}>{formatBiexWidth(shown.widthBasis)}</span>
      <details className="gl-biex-popover gl-popover">
        <summary
          className={"gl-tool" + (adjusted ? " gl-biex-adjusted" : "")}
          title={`${full}\n${t("The other biexponential parameters. Display only: gates are held in raw values, so no gate moves and no count changes.")}`}
          aria-label={`${axis} biex parameters`}
        >
          {"\u22ef"}
        </summary>
        <div className="gl-biex-popover-body">
          <div className="gl-biex-summary" title={full}>{formatBiexSummary(shown)}</div>
          {(["widthBasis", "pos", "neg", "maxValue"] as const).map((field) => (
            <div className="gl-biex-param" key={field} title={labels[field][1]}>
              <span className="gl-biex-param-label">{labels[field][0]}</span>
              {field === "widthBasis" ? <span className="gl-biex-slider-gap" /> : slider(field, `${axis} biex ${field}`)}
              {entry(field)}
            </div>
          ))}
          <div className="gl-biex-fixed">
            {t("Length {length} · table {table}", {
              length: String(params.channelRange),
              table: params.tableChannels !== undefined ? String(params.tableChannels) : t("as saved before 2026-09-24"),
            })}
            {params.spline ? ` · ${t("spline")}` : ""}
          </div>
          <div className="gl-biex-actions">
            <button
              className="gl-mini-btn"
              disabled={!adjusted}
              title={
                !target
                  ? undefined
                  : isDefault
                    ? t("Return to the default axis: the top of the scale at this channel's range, the decades from it, and the width basis estimated from its negative values ({params}).", { params: formatBiexFull(target) })
                    : t("Return to the parameters recorded for this channel: {params}.", { params: formatBiexFull(target) })
              }
              aria-label={`Reset ${axis} biex to ${isDefault ? "default" : "recorded"}`}
              onClick={() => {
                job.current = null;
                setPending(null);
                onReset();
              }}
            >
              {isDefault ? t("Reset to default") : t("Reset to recorded")}
            </button>
          </div>
        </div>
      </details>
    </>
  );
}

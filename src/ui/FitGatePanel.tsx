import { useLayoutEffect, useRef, useState } from "react";
import { FIT_GATE_RANGES, type FitGateResult, type FitGateSettings } from "../engine/fitGate";
import { useI18n } from "./i18n";

export interface FitGatePanelProps {
  /** Where to open, in client pixels; kept on screen. */
  at: [number, number];
  /** The gate's box on screen, [left, top, right, bottom]: the panel sits beside it, not over it. */
  avoid?: [number, number, number, number];
  gateName: string;
  gateType: "polygon" | "rectangle" | "ellipse";
  /** The file whose events the fit reads. */
  fileName: string;
  settings: FitGateSettings;
  /** The fit at these settings, drawn on the plot meanwhile; null when the gate cannot be fitted. */
  result: FitGateResult | null;
  onChange: (settings: FitGateSettings) => void;
  onApply: () => void;
  onCancel: () => void;
}

/**
 * The settings of a gate fitted to its events, floating by the gate: how many of its events to
 * wrap, how far past them to sit, how many vertices a polygon keeps. Each change redraws the
 * fitted gate on the plot; Apply commits it as one edit, Cancel leaves the gate as it was.
 */
export function FitGatePanel({ at, avoid, gateName, gateType, fileName, settings, result, onChange, onApply, onCancel }: FitGatePanelProps) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: at[0], top: at[1] });
  useLayoutEffect(() => {
    if (!root.current) return;
    const rect = root.current.getBoundingClientRect();
    const fitsX = (left: number) => left >= 4 && left + rect.width <= window.innerWidth - 4;
    const fitsY = (top: number) => top >= 4 && top + rect.height <= window.innerHeight - 4;
    // Beside the gate where there is room (to its right, else its left, else below, else above),
    // level with the click; otherwise just off the click.
    let left = at[0] + 8, top = at[1] + 8;
    if (avoid) {
      const [l, tp, r, b] = avoid;
      const level = Math.max(4, Math.min(at[1] - rect.height / 3, window.innerHeight - rect.height - 4));
      if (fitsX(r + 12)) { left = r + 12; top = level; }
      else if (fitsX(l - rect.width - 12)) { left = l - rect.width - 12; top = level; }
      else if (fitsY(b + 12)) { left = Math.max(4, Math.min(at[0] - rect.width / 2, window.innerWidth - rect.width - 4)); top = b + 12; }
      else if (fitsY(tp - rect.height - 12)) { left = Math.max(4, Math.min(at[0] - rect.width / 2, window.innerWidth - rect.width - 4)); top = tp - rect.height - 12; }
    }
    setPosition({
      left: Math.max(4, Math.min(left, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(top, window.innerHeight - rect.height - 4)),
    });
    root.current.querySelector<HTMLInputElement>("input")?.focus();
  }, [at, avoid]);

  const pct = (part: number, whole: number) => (whole > 0 ? (100 * part) / whole : 0).toFixed(1);
  return (
    <div
      ref={root}
      className="gl-fit-panel"
      role="dialog"
      aria-label={t("Fit {gate} to its events", { gate: gateName })}
      style={{ left: position.left, top: position.top }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); onCancel(); }
        else if (event.key === "Enter") { event.preventDefault(); if (result) onApply(); }
      }}
    >
      <div className="gl-fit-panel-title">{t("Fit {gate} to its events", { gate: gateName })}</div>
      <label className="gl-fit-panel-row" title={t("The share of the gate's events the new boundary wraps, the densest first; below 100% the stragglers are left out")}>
        <span>{t("Keep")}</span>
        <input
          type="range"
          min={FIT_GATE_RANGES.keep.min * 100}
          max={FIT_GATE_RANGES.keep.max * 100}
          step={0.5}
          value={settings.keep * 100}
          onChange={(e) => onChange({ ...settings, keep: Number(e.target.value) / 100 })}
        />
        <output>{(settings.keep * 100).toFixed(1)}%</output>
      </label>
      <label className="gl-fit-panel-row" title={t("How far past the kept events the boundary sits, as a share of its own size")}>
        <span>{t("Margin")}</span>
        <input
          type="range"
          min={FIT_GATE_RANGES.margin.min * 100}
          max={FIT_GATE_RANGES.margin.max * 100}
          step={1}
          value={Math.round(settings.margin * 100)}
          onChange={(e) => onChange({ ...settings, margin: Number(e.target.value) / 100 })}
        />
        <output>{Math.round(settings.margin * 100)}%</output>
      </label>
      {gateType === "polygon" && (
        <label className="gl-fit-panel-row" title={t("The most vertices the fitted polygon keeps; fewer are easier to edit by hand")}>
          <span>{t("Vertices")}</span>
          <input
            type="range"
            min={FIT_GATE_RANGES.maxVertices.min}
            max={FIT_GATE_RANGES.maxVertices.max}
            step={1}
            value={settings.maxVertices}
            onChange={(e) => onChange({ ...settings, maxVertices: Number(e.target.value) })}
          />
          <output>{settings.maxVertices}</output>
        </label>
      )}
      <p className="gl-fit-panel-readout" role="status">
        {result
          ? t("Holds {held} events, {pct}% of the population; the gate held {before}, {was}%. On {file}.", {
              held: result.held.toLocaleString(),
              before: result.before.toLocaleString(),
              pct: pct(result.held, result.population),
              was: pct(result.before, result.population),
              file: fileName,
            })
          : t("Too few events in the gate to fit")}
      </p>
      <div className="gl-fit-panel-actions">
        <button className="gl-mini-btn" onClick={onCancel}>{t("Cancel")}</button>
        <button className="gl-mini-btn gl-fit-panel-apply" disabled={!result} onClick={onApply} title={t("Replace the gate's boundary with the fitted one; one Undo step")}>
          {t("Apply")}
        </button>
      </div>
    </div>
  );
}

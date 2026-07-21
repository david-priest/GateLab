// StrategyTab.tsx — the Strategy tab, mirroring GateLabR's Strategy tab. Traces a population's
// gating path (root→pop) and renders one back-gated biplot per gate step through the reused
// mini_plot.js grid (CytofMiniPlot.renderStrategyGrid), so the output matches GateLabR.

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { CoreState, Derived } from "../store";
import type { Sample } from "../engine/sample";
import { loadMiniPlots } from "../plots/loadPlots";
import { exportGridPNG, exportGridSVG, exportGridPDF } from "../plots/gridExport";
import { computeGatingStrategy, buildStrategyPayload } from "../engine/strategy";
import { computeMultiPopStrategy, buildMultiStrategyPayload } from "../engine/multiStrategy";
import { populationTreeOrder } from "../engine/populations";
import { sanitizeFilePart } from "../engine/fcsExport";
import { MultiColumnChecklist } from "./MultiColumnChecklist";
import { DensityColourControl } from "./DensityColourControl";

interface Props {
  sample: Sample;
  state: CoreState;
  derived: Derived;
  globalScales: Record<string, [number, number]>;
  dataRevision: number;
  /** App-held ref so the controls survive a tab switch (the tab unmounts when you leave it). */
  configRef: MutableRefObject<StrategyConfig | null>;
  densityColorPower: number;
  onDensityColorPowerChange: (value: number) => void;
}

type GateView = "forward" | "back";

export interface StrategyConfig {
  mode: "single" | "multi";
  exportDpi: number;
  multiPops: string[];
  popId: string;
  fullPath: boolean;
  gateView: GateView[];
  displayMode: string;
  maxEvents: number;
  allEvents: boolean;
  plotSize: number;
  nColumns: number;
  fitToColumns: boolean;
  pointSize: number;
  pointAlpha: number;
  contourThreshold: number;
  kdeBandwidth: number;
  pubStyle: boolean;
  gateLineWidth: number;
  fontTick: number;
  fontAxis: number;
  fontTitle: number;
  fontGate: number;
}

export function StrategyTab({
  sample,
  state,
  derived,
  globalScales,
  configRef,
  dataRevision,
  densityColorPower,
  onDensityColorPowerChange,
}: Props) {
  const rootId = state.root_population_id ?? "";
  const c0 = configRef.current; // restore on (re)mount; null = first-ever
  const [mode, setMode] = useState<"single" | "multi">(c0?.mode ?? "single");
  const [exportDpi, setExportDpi] = useState(c0?.exportDpi ?? 300); // SVG/PDF export resolution (72–1200)
  const [multiPops, setMultiPops] = useState<string[]>(c0?.multiPops ?? []);
  const [popId, setPopId] = useState(c0?.popId ?? state.active_population_id ?? rootId);
  const [fullPath, setFullPath] = useState(c0?.fullPath ?? false);
  const [gateView, setGateView] = useState<GateView[]>(c0?.gateView ?? ["forward"]);
  const [displayMode, setDisplayMode] = useState(c0?.displayMode ?? "pseudocolor");
  const [maxEvents, setMaxEvents] = useState(c0?.maxEvents ?? 10000);
  const [allEvents, setAllEvents] = useState(c0?.allEvents ?? false);
  const [plotSize, setPlotSize] = useState(c0?.plotSize ?? 200);
  const [nColumns, setNColumns] = useState(c0?.nColumns ?? 4);
  const [fitToColumns, setFitToColumns] = useState(c0?.fitToColumns ?? true);
  // Shared style controls (same bundle the Illustration tab exposes; mini_plot reads them all).
  const [pointSize, setPointSize] = useState(c0?.pointSize ?? 1.2);
  const [pointAlpha, setPointAlpha] = useState(c0?.pointAlpha ?? 0.35);
  const [contourThreshold, setContourThreshold] = useState(c0?.contourThreshold ?? 5);
  const [kdeBandwidth, setKdeBandwidth] = useState(c0?.kdeBandwidth ?? 0);
  const manualKdeBandwidth = useRef(c0?.kdeBandwidth && c0.kdeBandwidth > 0 ? c0.kdeBandwidth : 4);
  const [pubStyle, setPubStyle] = useState(c0?.pubStyle ?? false);
  const [gateLineWidth, setGateLineWidth] = useState(c0?.gateLineWidth ?? 1.5);
  const [fontTick, setFontTick] = useState(c0?.fontTick ?? 8);
  const [fontAxis, setFontAxis] = useState(c0?.fontAxis ?? 10);
  const [fontTitle, setFontTitle] = useState(c0?.fontTitle ?? 10);
  const [fontGate, setFontGate] = useState(c0?.fontGate ?? 8);
  const containerRef = useRef<HTMLDivElement>(null);

  // Follow the active population when it changes in the tree.
  useEffect(() => {
    if (state.active_population_id) setPopId(state.active_population_id);
  }, [state.active_population_id]);

  // Mirror the controls into the App-held ref after each render so they persist across tab switches.
  const currentConfig: StrategyConfig = {
    mode, exportDpi, multiPops, popId, fullPath, gateView, displayMode, maxEvents, allEvents,
    plotSize, nColumns, fitToColumns, pointSize, pointAlpha, contourThreshold, kdeBandwidth,
    pubStyle, gateLineWidth, fontTick, fontAxis, fontTitle, fontGate,
  };
  useEffect(() => {
    configRef.current = currentConfig;
  });

  // Pseudocolor isn't offered when both forward+back are shown (overlay needs scatter/contour).
  const bothViewsActive = gateView.includes("forward") && gateView.includes("back");
  useEffect(() => {
    if (bothViewsActive && displayMode === "pseudocolor") setDisplayMode("scatter");
  }, [bothViewsActive, displayMode]);

  const order = populationTreeOrder(state.populations, rootId);
  const selectablePops = order.filter(({ popId: id }) => id !== rootId);

  // Render (reactive to controls + gate changes, debounced so rapid changes coalesce).
  useEffect(() => {
    if (!containerRef.current) return;
    if (mode === "single" && !popId) return;
    const id = setTimeout(() => {
      const fontSizes = { tick: fontTick, axis_label: fontAxis, gate_label: fontGate, title: fontTitle };
      const cap = allEvents ? Infinity : maxEvents;

      if (mode === "multi") {
        const nodes = computeMultiPopStrategy(sample, state.gates, state.populations, rootId, derived.masks, multiPops, {
          maxEvents: cap,
          globalScales,
        });
        const payload = buildMultiStrategyPayload(nodes, {
          displayMode,
          plotSize,
          contourThreshold,
          pointAlpha,
          densityColorPower,
          pointSize,
          kdeBandwidth,
          pubStyle,
          gateLineWidth,
          fontSizes,
          contextTitle: `${multiPops.length} population${multiPops.length === 1 ? "" : "s"}`,
        });
        loadMiniPlots().renderMultiStrategyGrid("strategy-grid-container", payload);
        return;
      }

      let effMode = displayMode;
      if (gateView.includes("forward") && gateView.includes("back") && effMode === "pseudocolor") effMode = "scatter";
      const steps = computeGatingStrategy(sample, state.gates, state.populations, rootId, popId, { fullPath, maxEvents: cap });
      const finalMask = gateView.includes("back") ? derived.masks[popId] ?? null : null;
      const payload = buildStrategyPayload(sample, steps, finalMask, globalScales, {
        gateView,
        displayMode: effMode,
        maxEvents: cap,
        nColumns,
        plotSize,
        fitToColumns,
        contourThreshold,
        pointAlpha,
        densityColorPower,
        pointSize,
        kdeBandwidth,
        pubStyle,
        gateLineWidth,
        fontSizes,
        contextTitle: state.populations[popId]?.name,
      });
      loadMiniPlots().renderStrategyGrid("strategy-grid-container", payload);
    }, 200);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, multiPops, sample, popId, fullPath, gateView, displayMode, maxEvents, allEvents, plotSize, nColumns, fitToColumns,
      pointSize, pointAlpha, densityColorPower, contourThreshold, kdeBandwidth, pubStyle, gateLineWidth, fontTick, fontAxis, fontTitle, fontGate,
      state.gates, state.gate_version, globalScales, derived, dataRevision]);

  const toggleGateView = (v: GateView) =>
    setGateView((prev) => {
      const next = prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v];
      return next.length ? next : ["forward"];
    });

  const bothViews = gateView.includes("forward") && gateView.includes("back");
  const modeOpts = bothViews
    ? [{ v: "scatter", l: "Scatter" }, { v: "contour", l: "Contour" }]
    : [{ v: "scatter", l: "Scatter" }, { v: "pseudocolor", l: "Pseudo" }, { v: "contour", l: "Contour" }];

  const popName = sanitizeFilePart(state.populations[popId]?.name ?? "strategy");
  const isContour = displayMode === "contour";
  const num = (setter: (n: number) => void, fallback: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setter(Number.isFinite(v) ? v : fallback);
  };

  return (
    <div className="gl-tab-panel gl-tab-fill">
      <div className="gl-strategy-controls">
        <span className="gl-stats-opt-label">Mode</span>
        {(["single", "multi"] as const).map((m) => (
          <label key={m} className="gl-check">
            <input type="radio" name="strat-scope" checked={mode === m} onChange={() => setMode(m)} />
            {m === "single" ? "Single" : "Multiple pops"}
          </label>
        ))}
        {mode === "single" && (<>
        <span className="gl-ctl-sep" />
        <label className="gl-field-inline">
          Population
          <select value={popId} onChange={(e) => setPopId(e.target.value)}>
            {order.map(({ popId: id, depth }) => (
              <option key={id} value={id}>
                {" ".repeat(depth * 2)}
                {state.populations[id]?.name ?? id}
              </option>
            ))}
          </select>
        </label>
        <label className="gl-check">
          <input type="checkbox" checked={fullPath} onChange={(e) => setFullPath(e.target.checked)} />
          Full path from root
        </label>
        </>)}

        <span className="gl-ctl-sep" />
        <span className="gl-stats-opt-label">Gate view</span>
        {(["forward", "back"] as GateView[]).map((v) => (
          <label key={v} className="gl-check">
            <input type="checkbox" checked={gateView.includes(v)} onChange={() => toggleGateView(v)} />
            {v === "forward" ? "Forward" : "Back-gated"}
          </label>
        ))}

        <span className="gl-ctl-sep" />
        <span className="gl-stats-opt-label">Display</span>
        {modeOpts.map((m) => (
          <label key={m.v} className="gl-check">
            <input type="radio" name="strat-mode" checked={displayMode === m.v} onChange={() => setDisplayMode(m.v)} />
            {m.l}
          </label>
        ))}
      </div>

      <div className="gl-strategy-controls">
        <label className="gl-field-inline">
          Max events/panel
          <input
            type="number"
            min={0}
            step={1000}
            value={maxEvents}
            disabled={allEvents}
            onChange={(e) => setMaxEvents(Math.max(0, Math.floor(+e.target.value) || 0))}
          />
        </label>
        <label className="gl-check">
          <input type="checkbox" checked={allEvents} onChange={(e) => setAllEvents(e.target.checked)} />
          All events
        </label>
        <span className="gl-ctl-sep" />
        <label className="gl-field-inline">
          Plot size
          <input type="number" min={150} max={500} step={25} value={plotSize} onChange={(e) => setPlotSize(+e.target.value || 200)} />
        </label>
        <label className="gl-field-inline">
          Columns
          <input type="number" min={1} max={12} value={nColumns} onChange={(e) => setNColumns(Math.max(1, +e.target.value || 4))} />
        </label>
        <label className="gl-check">
          <input type="checkbox" checked={fitToColumns} onChange={(e) => setFitToColumns(e.target.checked)} />
          Fit to columns
        </label>
        <span className="gl-ctl-sep" />
        <label className="gl-field-inline" title="Export resolution for SVG/PDF (72–1200 DPI)">
          DPI
          <input type="number" min={72} max={1200} step={1} value={exportDpi} onChange={(e) => setExportDpi(Math.max(72, Math.min(1200, Math.round(+e.target.value) || 300)))} />
        </label>
        <button className="gl-mini-btn" onClick={() => exportGridPNG("strategy-grid-container-grid", popName + "_strategy")}>PNG</button>
        <button className="gl-mini-btn" onClick={() => exportGridSVG("strategy-grid-container-grid", popName + "_strategy", exportDpi)}>SVG</button>
        <button className="gl-mini-btn" onClick={() => void exportGridPDF("strategy-grid-container-grid", popName + "_strategy", exportDpi)}>PDF</button>
      </div>

      <div className="gl-strategy-controls">
        <label className="gl-field-inline">
          Point size
          <input type="number" min={0.1} max={5} step={0.1} value={pointSize} onChange={num(setPointSize, 1.2)} />
        </label>
        <label className="gl-field-inline">
          Opacity
          <input type="range" min={0.05} max={1} step={0.05} value={pointAlpha} onChange={num(setPointAlpha, 0.35)} />
          <span className="gl-num-badge">{pointAlpha.toFixed(2)}</span>
        </label>
        {displayMode === "pseudocolor" && (
          <DensityColourControl value={densityColorPower} onChange={onDensityColorPowerChange} />
        )}
        <label className="gl-field-inline">
          Contour %
          <input type="number" min={0} max={50} step={1} value={contourThreshold} onChange={num(setContourThreshold, 5)} />
        </label>
        {isContour && (
          <>
            <label className="gl-check" title="Choose a bandwidth automatically from the event count and panel size">
              <input
                type="checkbox"
                checked={kdeBandwidth === 0}
                onChange={(e) => {
                  if (e.target.checked) {
                    if (kdeBandwidth > 0) manualKdeBandwidth.current = kdeBandwidth;
                    setKdeBandwidth(0);
                  } else {
                    setKdeBandwidth(manualKdeBandwidth.current);
                  }
                }}
              />
              Auto smoothing
            </label>
            {kdeBandwidth > 0 && (
              <label className="gl-field-inline" title="Higher bandwidth gives stronger contour smoothing">
                Bandwidth
                <input
                  type="range"
                  min={0.2}
                  max={14}
                  step={0.2}
                  value={kdeBandwidth}
                  onChange={(e) => {
                    const next = Math.max(0.2, Number(e.target.value) || 4);
                    manualKdeBandwidth.current = next;
                    setKdeBandwidth(next);
                  }}
                />
                <span className="gl-num-badge">{kdeBandwidth.toFixed(1)}</span>
              </label>
            )}
          </>
        )}
        <span className="gl-ctl-sep" />
        <label className="gl-check">
          <input type="checkbox" checked={pubStyle} onChange={(e) => setPubStyle(e.target.checked)} />
          Publication style
        </label>
        <label className="gl-field-inline">
          Gate line
          <input type="number" min={0.5} max={5} step={0.25} value={gateLineWidth} onChange={num(setGateLineWidth, 1.5)} />
        </label>
        <span className="gl-ctl-sep" />
        <span className="gl-stats-opt-label">Fonts</span>
        <label className="gl-field-inline">Tick<input type="number" min={6} max={24} value={fontTick} onChange={num(setFontTick, 8)} /></label>
        <label className="gl-field-inline">Axis<input type="number" min={6} max={28} value={fontAxis} onChange={num(setFontAxis, 10)} /></label>
        <label className="gl-field-inline">Title<input type="number" min={6} max={28} value={fontTitle} onChange={num(setFontTitle, 10)} /></label>
        <label className="gl-field-inline">Gate<input type="number" min={6} max={24} value={fontGate} onChange={num(setFontGate, 8)} /></label>
      </div>

      {mode === "multi" && (
        <div className="gl-strategy-pop-picker">
          <div className="gl-picker-head">
            <span className="gl-stats-opt-label">Populations</span>
            <span className="gl-hint">{multiPops.length} of {selectablePops.length} selected</span>
            <button className="gl-mini-btn gl-picker-first-action" onClick={() => setMultiPops(selectablePops.map(({ popId: id }) => id))}>All</button>
            <button className="gl-mini-btn" onClick={() => setMultiPops([])}>None</button>
          </div>
          <MultiColumnChecklist
            items={selectablePops}
            ariaLabel="Strategy populations"
            selected={({ popId: id }) => multiPops.includes(id)}
            onToggle={({ popId: id }) => setMultiPops((previous) => (
              previous.includes(id) ? previous.filter((candidate) => candidate !== id) : [...previous, id]
            ))}
            getKey={({ popId: id }) => id}
            getLabel={({ popId: id }) => state.populations[id]?.name ?? id}
            getDepth={({ depth }) => depth}
            distribution="fill-first"
            visibleRows={6}
          />
        </div>
      )}
      <div id="strategy-grid-container" ref={containerRef} className="gl-mini-grid-container" />
    </div>
  );
}

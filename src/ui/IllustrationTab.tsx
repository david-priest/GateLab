// IllustrationTab.tsx — the Illustration tab, mirroring GateLabR feature-for-feature. A grid of
// populations (rows) × x-channels (cols) on a shared y-channel, histograms, or a
// population-by-channel summary heatmap,
// each cell showing that population's events with gate overlays — rendered via mini_plot.js
// renderIllustrationGrid. Exposes every control GateLabR's Illustration tab has: biplot/histogram,
// display mode + KDE contour smoothing, colour-by-population, overlay-per-channel, histogram fill /
// overlay behaviour, ridgeline (stacked) layout with heat-gradient fill, per-population colour
// palette, point size/opacity, publication style, gate line width, and per-axis font sizes.

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { CoreState, Derived } from "../store";
import type { Sample } from "../engine/sample";
import type { IllustrationConfig, IllustrationPreset } from "../engine/workspace";
import { loadMiniPlots } from "../plots/loadPlots";
import { exportGridPNG, exportGridSVG, exportGridPDF } from "../plots/gridExport";
import { buildIllustrationPayload } from "../engine/illustration";
import { populationTreeOrder } from "../engine/populations";
import { populationColor } from "../engine/palettes";
import {
  buildHeatmapPayload,
  heatmapScaleNeedsPopulationComparison,
  type HeatmapPalette,
  type HeatmapScaleMode,
  type HeatmapSummaryStat,
} from "../engine/heatmap";
import { MultiColumnChecklist } from "./MultiColumnChecklist";
import { CollapsiblePicker } from "./CollapsiblePicker";
import { DensityColourControl } from "./DensityColourControl";
import { useI18n } from "./i18n";

interface Props {
  sample: Sample;
  state: CoreState;
  derived: Derived;
  globalScales: Record<string, [number, number]>;
  defaultX: string;
  defaultY: string;
  /** App-held config ref: null until this tab first mounts, then the live illustration settings.
   *  App reads it to persist the config + save presets; it survives tab unmount/remount. */
  configRef: MutableRefObject<IllustrationConfig | null>;
  presets: IllustrationPreset[];
  onSavePreset: (name: string) => void;
  onDeletePreset: (name: string) => void;
  dataRevision: number;
  densityColorPower: number;
  onDensityColorPowerChange: (value: number) => void;
}

function snapshotConfig(config: IllustrationConfig): IllustrationConfig {
  return {
    ...config,
    popIds: [...config.popIds],
    xChannels: [...config.xChannels],
    popColors: { ...config.popColors },
  };
}

function configsMatch(a: IllustrationConfig, b: IllustrationConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function IllustrationTab({
  sample,
  state,
  derived,
  globalScales,
  defaultX,
  defaultY,
  configRef,
  presets,
  onSavePreset,
  onDeletePreset,
  dataRevision,
  densityColorPower,
  onDensityColorPowerChange,
}: Props) {
  const { t } = useI18n();
  const rootId = state.root_population_id ?? "";
  const order = populationTreeOrder(state.populations, rootId).filter(({ popId }) => popId !== rootId);
  const allChannels = sample.channels.map((c) => c.key);

  // Restore from the App-held config on (re)mount; null = first-ever mount → prop-derived defaults.
  const c0 = configRef.current;
  const initialPlotType = c0?.plotType ?? (c0?.yChannel === "" ? "histogram" : "biplot");
  const [plotType, setPlotType] = useState<"biplot" | "histogram" | "heatmap">(initialPlotType);
  const [popIds, setPopIds] = useState<string[]>(() => (c0 ? c0.popIds : order.slice(0, 4).map((o) => o.popId)));
  const [xChannels, setXChannels] = useState<string[]>(() => (c0 ? c0.xChannels : [defaultX]));
  const [yChannel, setYChannel] = useState(c0?.yChannel || defaultY);
  const [displayMode, setDisplayMode] = useState(c0?.displayMode ?? "pseudocolor");
  const [plotSize, setPlotSize] = useState(c0?.plotSize ?? 200);
  const [nColumns, setNColumns] = useState(c0?.nColumns ?? 4);
  const [fitToColumns, setFitToColumns] = useState(c0?.fitToColumns ?? true);
  const [maxEvents, setMaxEvents] = useState(c0?.maxEvents ?? 10000);
  const [allEvents, setAllEvents] = useState(c0?.allEvents ?? false);
  // Population colouring
  const [colorByPop, setColorByPop] = useState(c0?.colorByPop ?? false);
  const [overlayPops, setOverlayPops] = useState(c0?.overlayPops ?? false);
  const [popColors, setPopColors] = useState<Record<string, string>>(c0?.popColors ?? {});
  // Biplot points / style
  const [pointSize, setPointSize] = useState(c0?.pointSize ?? 1.2);
  const [pointAlpha, setPointAlpha] = useState(c0?.pointAlpha ?? 0.35);
  const [contourThreshold, setContourThreshold] = useState(c0?.contourThreshold ?? 5);
  const [kdeBandwidth, setKdeBandwidth] = useState(c0?.kdeBandwidth ?? 0);
  const manualKdeBandwidth = useRef(c0?.kdeBandwidth && c0.kdeBandwidth > 0 ? c0.kdeBandwidth : 4);
  const [pubStyle, setPubStyle] = useState(c0?.pubStyle ?? false);
  const [gateLineWidth, setGateLineWidth] = useState(c0?.gateLineWidth ?? 1.5);
  // Histogram / ridgeline
  const [histLineWidth, setHistLineWidth] = useState(c0?.histLineWidth ?? 1.8);
  const [histFill, setHistFill] = useState(c0?.histFill ?? false);
  const [histFillAlpha, setHistFillAlpha] = useState(c0?.histFillAlpha ?? 0.22);
  const [histOverlayMode, setHistOverlayMode] = useState(c0?.histOverlayMode ?? "front_opaque");
  const [histLayout, setHistLayout] = useState(c0?.histLayout ?? "grid");
  const [ridgeOverlap, setRidgeOverlap] = useState(c0?.ridgeOverlap ?? 0.7);
  const [ridgeColGap, setRidgeColGap] = useState(c0?.ridgeColGap ?? 8);
  const [ridgeGradient, setRidgeGradient] = useState(c0?.ridgeGradient ?? true);
  // Heatmap summary / scaling
  const [heatmapStat, setHeatmapStat] = useState<HeatmapSummaryStat>(c0?.heatmapStat ?? "median");
  const [heatmapScale, setHeatmapScale] = useState<HeatmapScaleMode>(c0?.heatmapScale ?? "column_minmax");
  const [heatmapPalette, setHeatmapPalette] = useState<HeatmapPalette>(c0?.heatmapPalette ?? "blue_white_yellow_red");
  const [heatmapCellSize, setHeatmapCellSize] = useState(c0?.heatmapCellSize ?? 30);
  const [heatmapShowValues, setHeatmapShowValues] = useState(c0?.heatmapShowValues ?? false);
  // Fonts
  const [fontTick, setFontTick] = useState(c0?.fontTick ?? 9);
  const [fontAxis, setFontAxis] = useState(c0?.fontAxis ?? 12);
  const [fontTitle, setFontTitle] = useState(c0?.fontTitle ?? 12);
  const [fontGate, setFontGate] = useState(c0?.fontGate ?? 10);
  const [scaleFontsWithPlot, setScaleFontsWithPlot] = useState(c0?.scaleFontsWithPlot ?? true);

  const [selectedPreset, setSelectedPreset] = useState("");
  const [exportDpi, setExportDpi] = useState(300); // SVG/PDF export resolution (72–1200)
  const containerRef = useRef<HTMLDivElement>(null);
  const isHistogram = plotType === "histogram";
  const isHeatmap = plotType === "heatmap";
  const isContour = plotType === "biplot" && displayMode === "contour";
  // Per-channel scaling (min-max or z-score) needs ≥2 populations to have a within-channel range;
  // with one population every cell collapses to a single flat value (minmax → 0.5, z-score → 0).
  const heatmapDegenerate =
    isHeatmap &&
    heatmapScaleNeedsPopulationComparison(heatmapScale, popIds.length);
  const isRidgeline = isHistogram && histLayout === "ridgeline";

  // Default colour = the population's STABLE slot (frozen: adding/removing a population never
  // reshuffles the others); a hand-picked popColors[popId] override still wins.
  const defaultColorFor = (popId: string) =>
    populationColor("default", state.populations[popId]?.colorSlot ?? Math.max(0, popIds.indexOf(popId)));
  const colorFor = (popId: string) => popColors[popId] ?? defaultColorFor(popId);

  // Assemble the live config and mirror it into the App-held ref after every render, so the
  // settings survive a tab unmount (persist across tab switches) and App can save them.
  const currentConfig: IllustrationConfig = {
    plotType, popIds, xChannels, yChannel, displayMode, plotSize, nColumns, fitToColumns, maxEvents, allEvents,
    colorByPop, overlayPops, popColors, pointSize, pointAlpha, contourThreshold, kdeBandwidth, pubStyle,
    densityColorPower,
    gateLineWidth, histLineWidth, histFill, histFillAlpha, histOverlayMode, histLayout, ridgeOverlap,
    ridgeColGap, ridgeGradient, heatmapStat, heatmapScale, heatmapPalette, heatmapCellSize,
    heatmapShowValues, fontTick, fontAxis, fontTitle, fontGate, scaleFontsWithPlot,
  };
  const [renderedConfig, setRenderedConfig] = useState<IllustrationConfig>(() => snapshotConfig(currentConfig));
  const renderPending = !configsMatch(currentConfig, renderedConfig);
  useEffect(() => {
    configRef.current = currentConfig;
  });

  // Apply a full config bundle (preset load).
  const applyConfig = (c: IllustrationConfig) => {
    setPlotType(c.plotType ?? (c.yChannel === "" ? "histogram" : "biplot"));
    setPopIds(c.popIds); setXChannels(c.xChannels); setYChannel(c.yChannel);
    setDisplayMode(c.displayMode); setPlotSize(c.plotSize); setNColumns(c.nColumns);
    setFitToColumns(c.fitToColumns); setMaxEvents(c.maxEvents); setAllEvents(c.allEvents);
    setColorByPop(c.colorByPop); setOverlayPops(c.overlayPops); setPopColors(c.popColors);
    setPointSize(c.pointSize); setPointAlpha(c.pointAlpha); setContourThreshold(c.contourThreshold);
    if (c.densityColorPower !== undefined) onDensityColorPowerChange(c.densityColorPower);
    if (c.kdeBandwidth > 0) manualKdeBandwidth.current = c.kdeBandwidth;
    setKdeBandwidth(c.kdeBandwidth); setPubStyle(c.pubStyle); setGateLineWidth(c.gateLineWidth);
    setHistLineWidth(c.histLineWidth); setHistFill(c.histFill); setHistFillAlpha(c.histFillAlpha);
    setHistOverlayMode(c.histOverlayMode); setHistLayout(c.histLayout); setRidgeOverlap(c.ridgeOverlap);
    setRidgeColGap(c.ridgeColGap); setRidgeGradient(c.ridgeGradient);
    setHeatmapStat(c.heatmapStat ?? "median"); setHeatmapScale(c.heatmapScale ?? "column_minmax");
    setHeatmapPalette(c.heatmapPalette ?? "blue_white_yellow_red");
    setHeatmapCellSize(c.heatmapCellSize ?? 30); setHeatmapShowValues(c.heatmapShowValues ?? false);
    setFontTick(c.fontTick); setFontAxis(c.fontAxis); setFontTitle(c.fontTitle); setFontGate(c.fontGate);
    setScaleFontsWithPlot(c.scaleFontsWithPlot ?? true);
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const c = renderedConfig;
    const renderedPlotType = c.plotType ?? (c.yChannel === "" ? "histogram" : "biplot");
    const cap = c.allEvents ? Infinity : c.maxEvents;
    const cols = c.nColumns || c.xChannels.length || 1;
    const renderedColorFor = (popId: string) =>
      c.popColors[popId] ?? populationColor(
        "default",
        state.populations[popId]?.colorSlot ?? Math.max(0, c.popIds.indexOf(popId)),
      );

    if (renderedPlotType === "heatmap") {
      const heatmap = buildHeatmapPayload(
        sample,
        state.populations,
        derived.masks,
        derived.stats.event_count,
        c.popIds,
        c.xChannels,
        {
          summaryStat: c.heatmapStat ?? "median",
          scaleMode: c.heatmapScale ?? "column_minmax",
          palette: c.heatmapPalette ?? "blue_white_yellow_red",
          cellSize: c.heatmapCellSize ?? 30,
          showValues: c.heatmapShowValues ?? false,
        },
      );
      loadMiniPlots().renderIllustrationGrid("illustration-grid-container", {
        containerId: "illustration-grid-container",
        plot_type: "heatmap",
        heatmap,
        font_sizes: { tick: c.fontTick, axis_label: c.fontAxis, gate_label: c.fontGate, title: c.fontTitle },
        scale_fonts_with_plot: c.scaleFontsWithPlot ?? true,
      });
      return;
    }

    const renderedYChannel = renderedPlotType === "biplot"
      ? (c.yChannel || defaultY || sample.channels[0]?.key || null)
      : null;
    const payload = buildIllustrationPayload(
      sample,
      state.gates,
      state.gate_order,
      state.populations,
      derived.masks,
      derived.stats.event_count,
      c.popIds,
      c.xChannels,
      renderedYChannel,
      globalScales,
      {
        displayMode: c.displayMode,
        maxEvents: cap,
        nColumns: cols,
        plotSize: c.plotSize,
        fitToColumns: c.fitToColumns,
        contourThreshold: c.contourThreshold,
        pointAlpha: c.pointAlpha,
        densityColorPower: c.densityColorPower ?? densityColorPower,
        pointSize: c.pointSize,
        kdeBandwidth: c.kdeBandwidth,
        colorByPop: c.colorByPop,
        overlayPops: c.overlayPops,
        // Pass an explicit colour for EVERY displayed pop (stable slot ?? manual override) so the
        // renderer never falls back to its own index-based palette (which would reshuffle on add).
        populationColors: Object.fromEntries(c.popIds.map((id) => [id, renderedColorFor(id)])),
        histLineWidth: c.histLineWidth,
        histFill: c.histFill,
        histFillAlpha: c.histFillAlpha,
        histOverlayMode: c.histOverlayMode,
        histLayout: c.histLayout,
        ridgeOverlap: c.ridgeOverlap,
        ridgeColGap: c.ridgeColGap,
        ridgeGradient: c.ridgeGradient,
        pubStyle: c.pubStyle,
        gateLineWidth: c.gateLineWidth,
        fontSizes: { tick: c.fontTick, axis_label: c.fontAxis, gate_label: c.fontGate, title: c.fontTitle },
        scaleFontsWithPlot: c.scaleFontsWithPlot ?? true,
      },
    );
    loadMiniPlots().renderIllustrationGrid("illustration-grid-container", payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sample, renderedConfig, state.gates, state.gate_order, state.populations,
    state.gate_version, globalScales, derived, dataRevision,
  ]);

  const toggle = <T,>(arr: T[], v: T): T[] => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const num = (setter: (n: number) => void, fallback: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setter(Number.isFinite(v) ? v : fallback);
  };

  return (
    <div className="gl-tab-panel gl-tab-fill">
      <div className="gl-illust-controls">
        <div className="gl-illust-row gl-illust-top-actions">
          <button
            className={`gl-btn gl-illust-render${renderPending ? " pending" : ""}`}
            title="Apply the current controls and rebuild the illustration"
            onClick={() => setRenderedConfig(snapshotConfig(currentConfig))}
          >
            {t("Render Illustration")}
          </button>
          {renderPending && <span className="gl-illust-pending">{t("Changes pending")}</span>}
        </div>
        {/* Named presets — save / load / delete the whole illustration config */}
        <div className="gl-illust-row">
          <label className="gl-field-inline">
            {t("Presets")}
            <select value={selectedPreset} onChange={(e) => setSelectedPreset(e.target.value)}>
              <option value="">{t("— select —")}</option>
              {presets.map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </label>
          <button
            className="gl-mini-btn"
            disabled={!selectedPreset}
            onClick={() => {
              const p = presets.find((pr) => pr.name === selectedPreset);
              if (p) applyConfig(p.config);
            }}
          >
            {t("Load")}
          </button>
          <button
            className="gl-mini-btn"
            onClick={() => {
              const name = window.prompt("Save current illustration settings as preset:")?.trim();
              if (name) {
                onSavePreset(name);
                setSelectedPreset(name);
              }
            }}
          >
            {t("Save…")}
          </button>
          <button
            className="gl-mini-btn"
            disabled={!selectedPreset}
            onClick={() => {
              onDeletePreset(selectedPreset);
              setSelectedPreset("");
            }}
          >
            {t("Delete")}
          </button>
        </div>
        {/* Plot type + display + contour smoothing */}
        <div className="gl-illust-row">
          {/* Explicit plot-type toggle — histograms used to be reachable only by picking a "no Y"
              option buried in the Y-channel dropdown, which was undiscoverable. */}
          <span className="gl-stats-opt-label">{t("Plot")}</span>
          {[
            { v: "biplot", l: "Biplot" },
            { v: "histogram", l: "Histogram" },
            { v: "heatmap", l: "Heatmap" },
          ].map((pt) => (
            <label key={pt.v} className="gl-check">
              <input
                type="radio"
                name="illust-plot-type"
                checked={plotType === pt.v}
                onChange={() => {
                  const next = pt.v as "biplot" | "histogram" | "heatmap";
                  setPlotType(next);
                  if (next === "biplot" && !yChannel) setYChannel(defaultY || allChannels[0] || "");
                }}
              />
              {t(pt.l)}
            </label>
          ))}
          {plotType === "biplot" && (
            <>
              <span className="gl-ctl-sep" />
              <label className="gl-field-inline">
                {t("Y channel")}
                <select value={yChannel} onChange={(e) => setYChannel(e.target.value)}>
                  {allChannels.map((c) => (
                    <option key={c} value={c}>{sample.labelForKey(c)}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          {plotType === "biplot" && (
            <>
              <span className="gl-ctl-sep" />
              <span className="gl-stats-opt-label">{t("Display")}</span>
              {[{ v: "scatter", l: "Scatter" }, { v: "pseudocolor", l: "Pseudo" }, { v: "contour", l: "Contour" }].map((m) => (
                <label key={m.v} className="gl-check">
                  <input type="radio" name="illust-mode" checked={displayMode === m.v} onChange={() => setDisplayMode(m.v)} />
                  {t(m.l)}
                </label>
              ))}
            </>
          )}
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
                {t("Auto smoothing")}
              </label>
              {kdeBandwidth > 0 && (
                <label className="gl-field-inline" title="Higher bandwidth gives stronger contour smoothing">
                  {t("Bandwidth")}
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
        </div>

        {/* Layout + sampling */}
        {!isHeatmap && <div className="gl-illust-row">
          <label className="gl-field-inline">
            {t("Plot size")}
            <input
              className="gl-size-slider"
              type="range" min={150} max={500} step={25} value={plotSize}
              title="Rendered panel size; click Render Illustration to apply"
              onChange={(e) => setPlotSize(Math.max(150, Math.min(500, +e.target.value || 200)))}
            />
            <span className="gl-num-badge">{plotSize}px</span>
          </label>
          <label className="gl-field-inline">
            {t("Columns")}
            <input type="number" min={1} max={12} value={nColumns} onChange={(e) => setNColumns(Math.max(1, +e.target.value || 4))} />
          </label>
          <label className="gl-check">
            <input type="checkbox" checked={fitToColumns} onChange={(e) => setFitToColumns(e.target.checked)} />
            {t("Fit to columns")}
          </label>
          <label className="gl-field-inline">
            {t("Max events")}
            <input type="number" min={0} step={1000} value={maxEvents} disabled={allEvents} onChange={(e) => setMaxEvents(Math.max(0, Math.floor(+e.target.value) || 0))} />
          </label>
          <label className="gl-check">
            <input type="checkbox" checked={allEvents} onChange={(e) => setAllEvents(e.target.checked)} />
            {t("All events")}
          </label>
        </div>}

        {/* Population colouring */}
        {!isHeatmap && <div className="gl-illust-row">
          <label className="gl-check">
            <input type="checkbox" checked={colorByPop} onChange={(e) => setColorByPop(e.target.checked)} />
            Colour each population
          </label>
          <label className="gl-check">
            <input type="checkbox" checked={overlayPops} onChange={(e) => setOverlayPops(e.target.checked)} />
            Overlay populations per channel
          </label>
        </div>}

        {/* Plot-family-specific appearance */}
        {plotType === "biplot" ? (
          <div className="gl-illust-row">
            <label className="gl-field-inline">
              {t("Point size")}
              <input type="number" min={0.1} max={5} step={0.1} value={pointSize} onChange={num(setPointSize, 1.2)} />
            </label>
            <label className="gl-field-inline">
              {t("Opacity")}
              <input type="range" min={0.05} max={1} step={0.05} value={pointAlpha} onChange={num(setPointAlpha, 0.35)} />
              <span className="gl-num-badge">{pointAlpha.toFixed(2)}</span>
            </label>
            {displayMode === "pseudocolor" && (
              <DensityColourControl value={densityColorPower} onChange={onDensityColorPowerChange} />
            )}
            <label className="gl-field-inline">
              {t("Contour %")}
              <input type="number" min={0} max={50} step={1} value={contourThreshold} onChange={num(setContourThreshold, 5)} />
            </label>
            <span className="gl-ctl-sep" />
            <label className="gl-check">
              <input type="checkbox" checked={pubStyle} onChange={(e) => setPubStyle(e.target.checked)} />
              {t("Publication style")}
            </label>
            <label className="gl-field-inline">
              {t("Gate line")}
              <input type="number" min={0.5} max={5} step={0.25} value={gateLineWidth} onChange={num(setGateLineWidth, 1.5)} />
            </label>
          </div>
        ) : plotType === "histogram" ? (
          <>
            <div className="gl-illust-row">
              <label className="gl-field-inline">
                Line width
                <input type="number" min={0.5} max={6} step={0.1} value={histLineWidth} onChange={num(setHistLineWidth, 1.8)} />
              </label>
              <label className="gl-check">
                <input type="checkbox" checked={histFill} onChange={(e) => setHistFill(e.target.checked)} />
                Fill area
              </label>
              <label className="gl-field-inline">
                Fill opacity
                <input type="range" min={0} max={1} step={0.05} value={histFillAlpha} onChange={num(setHistFillAlpha, 0.22)} />
                <span className="gl-num-badge">{histFillAlpha.toFixed(2)}</span>
              </label>
              <label className="gl-field-inline">
                Overlay fill
                <select value={histOverlayMode} onChange={(e) => setHistOverlayMode(e.target.value)}>
                  <option value="front_opaque">Front opaque</option>
                  <option value="blend">Blend fills</option>
                </select>
              </label>
              <label className="gl-field-inline">
                Layout
                <select value={histLayout} onChange={(e) => setHistLayout(e.target.value)}>
                  <option value="grid">Grid (one panel / pop)</option>
                  <option value="ridgeline">Ridgeline (stacked)</option>
                </select>
              </label>
            </div>
            {isRidgeline && (
              <div className="gl-illust-row">
                <label className="gl-field-inline">
                  Ridge overlap
                  <input type="range" min={0} max={0.95} step={0.05} value={ridgeOverlap} onChange={num(setRidgeOverlap, 0.7)} />
                  <span className="gl-num-badge">{ridgeOverlap.toFixed(2)}</span>
                </label>
                <label className="gl-field-inline">
                  Column gap
                  <input type="number" min={0} max={60} step={2} value={ridgeColGap} onChange={num(setRidgeColGap, 8)} />
                </label>
                <label className="gl-check">
                  <input type="checkbox" checked={ridgeGradient} onChange={(e) => setRidgeGradient(e.target.checked)} />
                  Heat gradient fill
                </label>
              </div>
            )}
          </>
        ) : (
          <div className="gl-illust-row">
            <label className="gl-field-inline">
              {t("Summary")}
              <select value={heatmapStat} onChange={(e) => setHeatmapStat(e.target.value as HeatmapSummaryStat)}>
                <option value="median">{t("Median")}</option>
                <option value="mean">{t("Mean")}</option>
              </select>
            </label>
            <label className="gl-field-inline">
              {t("Scale")}
              <select value={heatmapScale} onChange={(e) => setHeatmapScale(e.target.value as HeatmapScaleMode)}>
                <option value="column_minmax">{t("Per channel (0–1)")}</option>
                <option value="row_minmax">{t("Per population (0–1)")}</option>
                <option value="column_zscore">{t("Per-channel z-score")}</option>
                <option value="none">{t("None (transformed expression)")}</option>
              </select>
            </label>
            <label className="gl-field-inline">
              {t("Palette")}
              <select value={heatmapPalette} onChange={(e) => setHeatmapPalette(e.target.value as HeatmapPalette)}>
                <option value="heat">Histogram heat (black→yellow)</option>
                <option value="viridis">Viridis</option>
                <option value="blue_white_yellow_red">RColorBrewer RdYlBu (blue→yellow→red)</option>
              </select>
            </label>
            <label className="gl-field-inline">
              {t("Plot size")}
              <input
                className="gl-size-slider"
                type="range" min={16} max={72} step={2} value={heatmapCellSize}
                title={t("Heatmap cell size; click Render Illustration to apply")}
                onChange={(e) => setHeatmapCellSize(Math.max(16, Math.min(72, Math.round(+e.target.value) || 30)))}
              />
              <span className="gl-num-badge">{heatmapCellSize}px</span>
            </label>
            <label className="gl-check">
              <input type="checkbox" checked={heatmapShowValues} onChange={(e) => setHeatmapShowValues(e.target.checked)} />
              {t("Show values")}
            </label>
            <span className="gl-illust-pending" style={{ color: "#64748b" }}>
              {t("Uses all events; empty populations are grey.")}
            </span>
            {heatmapDegenerate && (
              <div className="gl-comp-warning" role="status">
                <span>
                  {t(
                    "{scale} needs at least two populations to have a within-channel range. With one population every cell collapses to a single flat value, giving an uninformative row. Switch to unscaled transformed expression, or add another population.",
                    {
                      scale: t(heatmapScale === "column_zscore"
                        ? "Per-channel z-score"
                        : "Per channel (0–1)"),
                    },
                  )}
                </span>
                <button
                  type="button"
                  className="gl-mini-btn"
                  onClick={() => setHeatmapScale("none")}
                >
                  {t("Use transformed expression")}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Fonts + export */}
        <div className="gl-illust-row">
          <span className="gl-stats-opt-label">{t("Fonts")}</span>
          <label className="gl-field-inline">{t("Tick")}<input type="number" min={6} max={24} value={fontTick} onChange={num(setFontTick, 9)} /></label>
          <label className="gl-field-inline">{t("Axis")}<input type="number" min={6} max={28} value={fontAxis} onChange={num(setFontAxis, 12)} /></label>
          <label className="gl-field-inline">{t("Title")}<input type="number" min={6} max={28} value={fontTitle} onChange={num(setFontTitle, 12)} /></label>
          <label className="gl-field-inline">{t("Gate")}<input type="number" min={6} max={24} value={fontGate} onChange={num(setFontGate, 10)} /></label>
          <label className="gl-check" title="Scale these base font sizes with the rendered plot or heatmap cell size">
            <input type="checkbox" checked={scaleFontsWithPlot} onChange={(e) => setScaleFontsWithPlot(e.target.checked)} />
            Scale with plot
          </label>
          <span className="gl-ctl-sep" />
          <label className="gl-field-inline" title="Export resolution for SVG/PDF (72–1200 DPI)">
            DPI
            <input type="number" min={72} max={1200} step={1} value={exportDpi} onChange={(e) => setExportDpi(Math.max(72, Math.min(1200, Math.round(+e.target.value) || 300)))} />
          </label>
          <button className="gl-mini-btn" onClick={() => exportGridPNG("illustration-grid-container-grid", "illustration")}>PNG</button>
          <button className="gl-mini-btn" onClick={() => exportGridSVG("illustration-grid-container-grid", "illustration", exportDpi)}>SVG</button>
          <button className="gl-mini-btn" onClick={() => void exportGridPDF("illustration-grid-container-grid", "illustration", exportDpi)}>PDF</button>
        </div>
      </div>

      {/* Responsive, equal-height multi-column channel + population checklists. */}
      <div className="gl-illust-pickers">
        <CollapsiblePicker
          className="gl-illust-picker"
          label={isHeatmap ? t("Channels") : t("X channels")}
          summary={t("{selected} of {total} selected", { selected: xChannels.length, total: allChannels.length })}
          actions={(
            <>
              <button className="gl-mini-btn" onClick={() => setXChannels(allChannels)}>{t("All")}</button>
              <button className="gl-mini-btn" onClick={() => setXChannels([defaultX])}>{t("Reset")}</button>
            </>
          )}
        >
          <MultiColumnChecklist
            items={allChannels}
            ariaLabel={isHeatmap ? "Heatmap channels" : "Illustration X channels"}
            selected={(channel) => xChannels.includes(channel)}
            onToggle={(channel) => setXChannels((previous) => toggle(previous, channel))}
            getKey={(channel) => channel}
            getLabel={(channel) => sample.labelForKey(channel)}
            visibleRows={15}
            height={300}
          />
        </CollapsiblePicker>

        <CollapsiblePicker
          className="gl-illust-picker"
          label={t("Populations")}
          summary={t("{selected} of {total} selected", { selected: popIds.length, total: order.length })}
          actions={(
            <>
              <button className="gl-mini-btn" onClick={() => setPopIds(order.map((o) => o.popId))}>{t("All")}</button>
              <button className="gl-mini-btn" onClick={() => setPopIds([])}>{t("None")}</button>
            </>
          )}
        >
          <MultiColumnChecklist
            items={order}
            ariaLabel="Illustration populations"
            selected={({ popId }) => popIds.includes(popId)}
            onToggle={({ popId }) => setPopIds((previous) => toggle(previous, popId))}
            getKey={({ popId }) => popId}
            getLabel={({ popId }) => state.populations[popId]?.name ?? popId}
            getDepth={({ depth }) => depth}
            distribution="fill-first"
            visibleRows={15}
            height={300}
            renderTrailing={({ popId }) => (
              popIds.includes(popId) && !isHeatmap && (colorByPop || overlayPops) ? (
                <input
                  type="color"
                  className="gl-pop-color"
                  title="Population colour"
                  value={colorFor(popId)}
                  onChange={(e) => setPopColors((colors) => ({ ...colors, [popId]: e.target.value }))}
                />
              ) : null
            )}
          />
        </CollapsiblePicker>
      </div>

      <div id="illustration-grid-container" ref={containerRef} className="gl-mini-grid-container" />
    </div>
  );
}

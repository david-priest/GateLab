// StrategyTab.tsx — the Strategy tab, mirroring GateLabR's Strategy tab. Traces a population's
// gating path (root→pop) and renders one back-gated biplot per gate step through the reused
// mini_plot.js grid (CytofMiniPlot.renderStrategyGrid), so the output matches GateLabR.
// Pooled, it draws the Gating tab's pool: every step from the pooled files' events together,
// by the rules the Illustration and Layout tabs pool by (pooledStrategy.ts).

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { CoreState, Derived } from "../store";
import type { Sample } from "../engine/sample";
import { loadMiniPlots } from "../plots/loadPlots";
import { GATE_EDGE_MODES, type GateEdgeMode } from "./gateEdgeModes";
import { exportGridPNG, exportGridSVG, exportGridPDF } from "../plots/gridExport";
import { computeGatingStrategy, buildStrategyPayload, buildPooledStrategyPayload, type StrategyPart } from "../engine/strategy";
import { computeMultiPopStrategy, buildMultiStrategyPayload, flowLayout, tidyLayout } from "../engine/multiStrategy";
import { computePooledGatingStrategy, computePooledMultiPopStrategy, type StrategyLeftOut, type StrategyMember } from "../engine/pooledStrategy";
import { figureHierarchies, resolvePopulationInTree, type FigureSample } from "../engine/figure";
import { useFigureSources } from "./useFigureSources";
import { populationTreeOrder } from "../engine/populations";
import { sanitizeFilePart } from "../engine/fcsExport";
import type { LayoutPlotRecipe, LayoutStrategyRecipe } from "../engine/layout";
import type { StrategyConfig } from "../engine/workspace";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import type { MenuEntry } from "./MenuButton";
import { StrategyPopulationPicker } from "./StrategyPopulationPicker";
import { drawStrategyArrows, strategyArrowGap, strategyArrows } from "./strategyArrows";
import { attachGridPan, type PannablePanel } from "./gridPan";
import { DensityColourControl } from "./DensityColourControl";
import { useI18n } from "./i18n";

interface Props {
  sample: Sample;
  sampleName?: string;
  state: CoreState;
  derived: Derived;
  globalScales: Record<string, [number, number]>;
  dataRevision: number;
  /** App-held ref so the controls survive a tab switch (the tab unmounts when you leave it). */
  configRef: MutableRefObject<StrategyConfig | null>;
  densityColorPower: number;
  onDensityColorPowerChange: (value: number) => void;
  /** Fit these channels to their data plus the gates drawn on them. */
  onFitChannels: (keys: readonly string[]) => void;
  /** Every file of the workspace as the Illustration tab sees it, for a pooled strategy. */
  files: readonly FigureSample[];
  /** The Gating tab's pool, in file order; null while the Gating tab draws one file. */
  poolIds: readonly string[] | null;
  /** Checked files the Gating tab left out of its pool, and why. */
  poolNote?: string;
  /** Whether a pool can be started: two or more files are checked. */
  poolable: boolean;
  /** An SCE host's files are samples. */
  isSceHost?: boolean;
  onPoolChange: (pooled: boolean) => void;
  /** The file viewed on the Gating tab, which a strategy or plot sent to the Layout tab is of. */
  activeSampleId?: string | null;
  /** Put the strategy, or one of its plots, on the Layout tab. */
  /** The strategy to the Layout tab; for a multi-population grid, with the frame its shape calls for. */
  onAddToLayout?: (recipe: LayoutStrategyRecipe | LayoutPlotRecipe, size?: { width: number; height: number }) => void;
  /** Show a step's population on its gate's channels on the Gating tab. */
  onOpenStep?: (populationId: string, xChannel: string, yChannel: string) => void;
  /** A gate label dragged on a panel: the new offset goes to the gate in the given tree, as on the Illustration tab. */
  onGateLabelMove?: (hierarchyId: string, gateId: string, offset: [number, number], quadrant?: number) => void;
  /** A panel panned or stretched: the channel's new range for the workspace's scales, as the Gating tab's drag sets it. */
  onScaleChange?: (channelKey: string, range: [number, number]) => void;
}

type GateView = StrategyConfig["gateView"][number];

export type { StrategyConfig };

export function StrategyTab({
  onFitChannels,
  sample,
  sampleName,
  state,
  derived,
  globalScales,
  configRef,
  dataRevision,
  densityColorPower,
  onDensityColorPowerChange,
  files,
  poolIds,
  poolNote,
  poolable,
  isSceHost = false,
  onPoolChange,
  activeSampleId,
  onAddToLayout,
  onOpenStep,
  onGateLabelMove,
  onScaleChange,
}: Props) {
  /** Channels of the plots most recently rendered, for Fit. */
  const shownChannels = useRef<readonly string[]>([]);
  const { t } = useI18n();
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
  const [contourLevels, setContourLevels] = useState(c0?.contourLevels ?? 10);
  const [showArrows, setShowArrows] = useState(c0?.showArrows ?? true);
  const [arrowWidth, setArrowWidth] = useState(c0?.arrowWidth ?? 1.5);
  const [arrowAnchor, setArrowAnchor] = useState<"label" | "gate">(c0?.arrowAnchor ?? "label");
  const [kdeBandwidth, setKdeBandwidth] = useState(c0?.kdeBandwidth ?? 0);
  const manualKdeBandwidth = useRef(c0?.kdeBandwidth && c0.kdeBandwidth > 0 ? c0.kdeBandwidth : 4);
  const [pubStyle, setPubStyle] = useState(c0?.pubStyle ?? false);
  const [gateLabelBold, setGateLabelBold] = useState(c0?.gateLabelBold ?? false);
  const [labelBackground, setLabelBackground] = useState(c0?.labelBackground ?? 0.6);
  const [layout, setLayout] = useState<"tree" | "flow">(c0?.layout ?? "tree");
  const [gateLineWidth, setGateLineWidth] = useState(c0?.gateLineWidth ?? 1.5);
  const [gateEdgeMode, setGateEdgeMode] = useState<GateEdgeMode>(c0?.gateEdgeMode ?? "straight-bow");
  const [fontTick, setFontTick] = useState(c0?.fontTick ?? 12);
  const [fontAxis, setFontAxis] = useState(c0?.fontAxis ?? 12);
  const [fontTitle, setFontTitle] = useState(c0?.fontTitle ?? 12);
  const [fontGate, setFontGate] = useState(c0?.fontGate ?? 12);

  // Pooled, the strategy draws the Gating tab's pool: each member prepared as the Illustration
  // tab prepares a file (cached across the tabs), the traced population followed into each
  // member's tree by lineage, so a tailored copy traces its own gates.
  const pooled = poolIds !== null;
  const poolKey = (poolIds ?? []).join("|");
  const poolList = useMemo(() => (poolKey ? poolKey.split("|") : []), [poolKey]);
  const sources = useFigureSources(files, poolList, state, dataRevision);
  const trees = useMemo(() => figureHierarchies(state), [state]);
  const poolReady = !pooled || (sources.current && sources.pending === 0);
  const members = useMemo((): StrategyMember[] | null => {
    if (!poolReady || !pooled) return null;
    return poolList.flatMap((id) => {
      const source = sources.sources.find((entry) => entry.id === id);
      if (!source) return [];
      const resolved = resolvePopulationInTree(popId, source.tree, trees, state.active_hierarchy_id);
      return [{ id: source.id, name: source.name, sample: source.sample, tree: source.tree, gating: source.gating, populationId: resolved.missing ? "" : resolved.id }];
    });
    // The sources change identity as each file is prepared; poolReady says when they are all there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolReady, pooled, poolList, sources.sources, popId, trees, state.active_hierarchy_id]);
  /** What the last pooled draw left out: gates the files do not hold alike, and files left out. */
  const [poolReport, setPoolReport] = useState<{ drawn: number; omittedGates: string[]; leftOut: StrategyLeftOut[] } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  /** The channels and ranges of each drawn panel, by its cell key, for the navigate drag. */
  const panelsRef = useRef<Map<string, PannablePanel>>(new Map());
  /** The multi-population grid's shape and panel size as last drawn, for the Layout block. */
  const gridShapeRef = useRef<{ rows: number; cols: number; plotSize: number; gap: number; fonts: { tick: number; axis_label: number; gate_label: number; title: number } } | null>(null);
  /** The panel size the multi-population grid was last drawn at, shown beside Plot size when Fit made it smaller. */
  const [drawnSize, setDrawnSize] = useState<number | null>(null);
  const onScaleChangeRef = useRef(onScaleChange);
  onScaleChangeRef.current = onScaleChange;
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    return attachGridPan(
      container,
      (cell) => panelsRef.current.get(cell.getAttribute("data-plot-key") ?? "") ?? null,
      (panel, xr, yr) => {
        onScaleChangeRef.current?.(panel.xKey, xr);
        if (panel.yKey !== panel.xKey) onScaleChangeRef.current?.(panel.yKey, yr);
      },
    );
  }, []);
  const [renderPending, setRenderPending] = useState(true);
  const [renderError, setRenderError] = useState("");
  const [panelCount, setPanelCount] = useState(0);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  useEffect(() => {
    if (!containerRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => setAvailableWidth(Math.round(entries[0].contentRect.width)));
    observer.observe(containerRef.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setMultiPops(ids => ids.filter(id => !!state.populations[id]));
  }, [state.active_hierarchy_id]); // Local population IDs must not leak into another hierarchy.

  // Follow the active population when it changes in the tree.
  useEffect(() => {
    if (state.active_population_id) setPopId(state.active_population_id);
  }, [state.active_population_id]);

  // Mirror the controls into the App-held ref after each render so they persist across tab switches.
  const currentConfig: StrategyConfig = {
    mode, exportDpi, multiPops, popId, fullPath, gateView, displayMode, maxEvents, allEvents,
    plotSize, nColumns, fitToColumns, pointSize, pointAlpha, contourThreshold, contourLevels, kdeBandwidth,
    pubStyle, gateLineWidth, gateEdgeMode, gateLabelBold, labelBackground, showArrows, arrowWidth, arrowAnchor, layout, fontTick, fontAxis, fontTitle, fontGate,
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
    setRenderPending(true); setRenderError("");
    const id = setTimeout(() => {
      try {
      if (mode === "single" && !state.populations[popId]) { containerRef.current?.replaceChildren(); setPanelCount(0); setPoolReport(null); return; }
      // Pooled and still preparing the files: nothing to draw yet; the status says so.
      if (pooled && !members) { containerRef.current?.replaceChildren(); setPanelCount(0); setPoolReport(null); return; }
      const fontSizes = { tick: fontTick, axis_label: fontAxis, gate_label: fontGate, title: fontTitle };
      const cap = allEvents ? Infinity : maxEvents;
      // A dragged label goes to the gate itself, as on the Illustration tab: the offset is in
      // the gate's own orientation, since a strategy panel draws a gate on its own channels.
      const onLabelMove = onGateLabelMove
        ? (gateId: string, offset: [number, number], quadrant?: number) => onGateLabelMove(state.active_hierarchy_id, gateId, offset, quadrant)
        : undefined;

      if (mode === "multi") {
        const pool = members
          ? computePooledMultiPopStrategy(members, multiPops, state.active_hierarchy_id, trees, { maxEvents: cap, globalScales })
          : null;
        const computed = pool ? pool.nodes : computeMultiPopStrategy(sample, state.gates, state.populations, rootId, derived.masks, multiPops, {
          maxEvents: cap,
          globalScales,
        });
        const nodes = layout === "flow" ? flowLayout(computed, nColumns, state.populations) : tidyLayout(computed, state.populations);
        // Fit ticked: the panels are drawn at Plot size, or smaller when the grid's columns would
        // not otherwise fit the width (never larger; the renderer's smallest panel is 120 px), and
        // the text is drawn smaller by the same ratio, so a fitted strategy is the strategy at
        // Plot size seen smaller rather than small panels under full-size labels. Unticked: the
        // panels are Plot size, and a strategy wider than the pane scrolls.
        // The gutters are as wide as the busiest one's lines need, so lines that run side by side
        // stay apart.
        const arrows = showArrows ? strategyArrows(nodes, state.populations) : [];
        const gridGap = showArrows ? strategyArrowGap(arrows) : 8;
        const gridCols = nodes.length ? Math.max(...nodes.map((node) => node.col)) + 1 : 1;
        const fitted = fitToColumns && availableWidth > 0
          ? Math.max(120, Math.min(plotSize, Math.floor((availableWidth - 8 - gridGap * (gridCols - 1)) / gridCols)))
          : plotSize;
        const fontScale = fitted < plotSize ? fitted / plotSize : 1;
        const scaled = (size: number) => Math.max(5, Math.round(size * fontScale * 10) / 10);
        const gridFonts = fontScale < 1
          ? { tick: scaled(fontSizes.tick), axis_label: scaled(fontSizes.axis_label), gate_label: scaled(fontSizes.gate_label), title: scaled(fontSizes.title) }
          : fontSizes;
        gridShapeRef.current = nodes.length
          ? { rows: Math.max(...nodes.map((node) => node.row)) + 1, cols: gridCols, plotSize: fitted, fonts: gridFonts, gap: gridGap }
          : null;
        setDrawnSize(fitted);
        const payload = buildMultiStrategyPayload(nodes, {
          displayMode,
          plotSize: fitted,
          contourThreshold,
          contourLevels,
          onLabelMove,
          gateLabelBold,
          labelBackground,
          // Room for the arrows to run between the panels.
          gridGap: showArrows ? gridGap : undefined,
          pointAlpha,
          densityColorPower,
          pointSize,
          kdeBandwidth,
          pubStyle,
          gateLineWidth,
          gateEdgeMode,
          fontSizes: gridFonts,
          // The grid's title names what it draws, so an export says which file or pool it was.
          contextTitle: pool
            ? `${multiPops.length} population${multiPops.length === 1 ? "" : "s"} · ${pool.drawn.length} ${isSceHost ? "samples" : "files"} pooled`
            : `${multiPops.length} population${multiPops.length === 1 ? "" : "s"}${sampleName ? ` · ${sampleName}` : ""}`,
        });
        loadMiniPlots().renderMultiStrategyGrid("strategy-grid-container", payload);
        panelsRef.current = new Map(nodes.map((node) => [node.node_id, {
          xKey: sample.keyForLabel(node.x_channel), yKey: sample.keyForLabel(node.y_channel), xr: node.x_range, yr: node.y_range,
        }]));
        if (containerRef.current) {
          drawStrategyArrows(containerRef.current, arrows, { color: pubStyle ? "#444444" : null, width: arrowWidth, anchor: arrowAnchor });
        }
        shownChannels.current = pool ? pool.channels : nodes.flatMap(node => node.gates.flatMap(g => {
          const gate = state.gates[g.gate_id]; return gate ? [gate.x_channel, gate.y_channel] : [];
        }));
        setPanelCount(nodes.length);
        setPoolReport(pool ? { drawn: pool.drawn.length, omittedGates: pool.omittedGates, leftOut: pool.leftOut } : null);
        return;
      }

      let effMode = displayMode;
      if (gateView.includes("forward") && gateView.includes("back") && effMode === "pseudocolor") effMode = "scatter";
      const pool = members ? computePooledGatingStrategy(members, trees, { fullPath, maxEvents: cap }) : null;
      const steps = pool ? pool.steps : computeGatingStrategy(sample, state.gates, state.populations, rootId, popId, { fullPath, maxEvents: cap });
      // Remembered so Fit can act on exactly the plots on screen, rather than every channel a
      // gate happens to use.
      shownChannels.current = steps.flatMap((s) => [s.x_channel, s.y_channel]);
      const back = gateView.includes("back");
      const finalMask = back ? derived.masks[popId] ?? null : null;
      const parts: StrategyPart[] = pool
        ? pool.drawn.map((member) => ({ sample: member.sample, finalMask: back ? member.gating.masks[member.populationId] ?? null : null }))
        : [];
      const payloadOptions = {
        gateView,
        displayMode: effMode,
        maxEvents: cap,
        nColumns,
        plotSize,
        fitToColumns,
        contourThreshold,
        contourLevels,
        onLabelMove,
        gateLabelBold,
        labelBackground,
        pointAlpha,
        densityColorPower,
        pointSize,
        kdeBandwidth,
        pubStyle,
        gateLineWidth,
        gateEdgeMode,
        fontSizes,
        // The grid's title names what it draws, so an export says which file or pool it was.
        contextTitle: pool
          ? `${state.populations[popId]?.name ?? ""} · ${pool.drawn.length} ${isSceHost ? "samples" : "files"} pooled`
          : [state.populations[popId]?.name, sampleName].filter((part) => !!part).join(" · "),
      };
      if (pool && !parts.length) { containerRef.current?.replaceChildren(); setPanelCount(0); setPoolReport({ drawn: 0, omittedGates: [], leftOut: pool.leftOut }); return; }
      const payload = pool
        ? buildPooledStrategyPayload(parts, steps, globalScales, payloadOptions)
        : buildStrategyPayload(sample, steps, finalMask, globalScales, payloadOptions);
      loadMiniPlots().renderStrategyGrid("strategy-grid-container", payload);
      panelsRef.current = new Map(
        ((payload as { steps?: { gate_id: string; x_range: [number, number]; y_range: [number, number] }[] }).steps ?? []).map((drawn, index) => [
          String(drawn.gate_id || index),
          { xKey: steps[index].x_channel, yKey: steps[index].y_channel, xr: drawn.x_range, yr: drawn.y_range },
        ]),
      );
      setPanelCount(steps.length);
      setPoolReport(pool ? { drawn: pool.drawn.length, omittedGates: pool.omittedGates, leftOut: pool.leftOut } : null);
      } catch (error) { setRenderError(error instanceof Error ? error.message : String(error)); setPanelCount(0); containerRef.current?.replaceChildren(); }
      finally { setRenderPending(false); }
    }, 200);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, multiPops, sample, popId, fullPath, gateView, displayMode, maxEvents, allEvents, plotSize, nColumns, fitToColumns,
      pointSize, pointAlpha, densityColorPower, contourThreshold, contourLevels, kdeBandwidth, pubStyle, gateLineWidth, gateEdgeMode, gateLabelBold, labelBackground, showArrows, arrowWidth, arrowAnchor, layout, fontTick, fontAxis, fontTitle, fontGate,
      state.gates, state.gate_version, globalScales, derived, dataRevision, availableWidth, pooled, members, trees, onGateLabelMove]);

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
  /** Each gate of the single-population path with the population it belongs to, as the grid draws them. */
  const stepOwners = useMemo(() => {
    const owners: { gateId: string; populationId: string; parentId: string | null }[] = [];
    const pop = state.populations[popId];
    if (!pop) return owners;
    const path: string[] = [];
    if (fullPath) {
      for (let cur: string | null = popId; cur && cur !== rootId; cur = state.populations[cur]?.parent_id ?? null) path.unshift(cur);
    } else path.push(popId);
    for (const id of path) {
      const owner = state.populations[id];
      for (const ref of owner?.gate_refs ?? []) owners.push({ gateId: ref.gate_id, populationId: id, parentId: owner?.parent_id ?? null });
    }
    return owners;
  }, [state.populations, popId, fullPath, rootId]);
  const layoutDisplayMode = displayMode === "contour" ? "contour" : displayMode === "scatter" ? "scatter" : "pseudocolor";
  /** The strategy as a Layout block: this file's path to the population, drawn as it is here. */
  const strategyRecipe = (): LayoutStrategyRecipe | null => {
    if (!activeSampleId) return null;
    if (mode === "multi") {
      const ids = multiPops.filter((id) => !!state.populations[id] && id !== rootId);
      // As drawn here: the panel size, the layout, the arrows and the appearance, which the block
      // keeps as its own settings over the sheet's.
      return ids.length
        ? {
            kind: "strategy", sampleId: activeSampleId, populationId: ids[0], fullPath: true, displayMode: layoutDisplayMode,
            populationIds: ids, layout, columns: nColumns, showArrows, arrowWidth, ...(arrowAnchor === "gate" ? { arrowAnchor } : {}), title: "{sample}",
            plotSize: gridShapeRef.current?.plotSize ?? plotSize,
            ...(gateLabelBold ? { gateLabelBold: true } : {}),
            labelBackground,
            style: {
              pointSize, pointAlpha, maxEvents: allEvents ? 0 : maxEvents, contourThreshold, contourLevels, kdeBandwidth,
              gateLineWidth, pubStyle,
              fontTick: gridShapeRef.current?.fonts.tick ?? fontTick,
              fontAxis: gridShapeRef.current?.fonts.axis_label ?? fontAxis,
              fontTitle: gridShapeRef.current?.fonts.title ?? fontTitle,
              fontGate: gridShapeRef.current?.fonts.gate_label ?? fontGate,
            },
          }
        : null;
    }
    return state.populations[popId] && popId !== rootId
      ? { kind: "strategy", sampleId: activeSampleId, populationId: popId, fullPath, displayMode: layoutDisplayMode }
      : null;
  };
  const addStrategyToLayout = () => {
    const recipe = strategyRecipe();
    if (!recipe || !onAddToLayout) return;
    // A multi-population block is framed at the size it is drawn here: the grid as measured,
    // with its title, else as its shape and panel size make it.
    const shape = recipe.populationIds?.length ? gridShapeRef.current : null;
    if (!shape) { onAddToLayout(recipe); return; }
    // As measured, the grid holds its own right and bottom gutters, where the arrows run.
    const gap = shape.gap, trailing = showArrows ? gap : 4;
    const grid = containerRef.current?.querySelector<HTMLElement>(".multi-strategy-grid");
    const title = containerRef.current?.querySelector<HTMLElement>(".strategy-context-title");
    const width = grid && grid.offsetWidth > 0 ? grid.offsetWidth : shape.cols * shape.plotSize + (shape.cols - 1) * gap + 4 + trailing;
    const height = (grid && grid.offsetHeight > 0 ? grid.offsetHeight : shape.rows * shape.plotSize + (shape.rows - 1) * gap + 4 + trailing) + (title && title.offsetHeight > 0 ? title.offsetHeight + 6 : 26);
    onAddToLayout(recipe, { width: width + 12, height: height + 12 });
  };
  const strategyToLayoutTitle = mode === "multi"
    ? (multiPops.length
      ? t("The strategy to these {count} populations on this file, as a block the Layout tab keeps drawing from the live gates, arrows included", { count: multiPops.length })
      : t("Choose populations first"))
    : t("The path to {population} on this file, as a strip of plots the Layout tab keeps drawing from the live gates", { population: state.populations[popId]?.name ?? "" });
  /**
   * The menu a right-click on the grid opens: the strategy to the Layout tab; for the step under
   * the pointer, that plot (the events it shows on its gate's channels) to the Layout tab or to
   * the Gating tab; then Fit and the exports.
   */
  const openGridMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!panelCount) return;
    const cell = (event.target as HTMLElement).closest<HTMLElement>(".mini-plot-cell");
    const owner = cell ? stepOwners.find((entry) => entry.gateId === cell.dataset.plotKey) : undefined;
    const gate = owner ? state.gates[owner.gateId] : undefined;
    const shown = owner ? owner.parentId ?? rootId : null;
    const stepItems: MenuEntry[] = owner && gate && shown && state.populations[shown]
      ? [
          {
            label: t("Add this plot to the Layout tab"),
            title: t("The events this step shows, {population}, on {x} against {y}, as a plot the Layout tab keeps drawing from the live gates", { population: state.populations[shown]?.name ?? "", x: gate.x_channel, y: gate.y_channel }),
            disabled: !activeSampleId || !onAddToLayout,
            onClick: () => {
              if (activeSampleId && onAddToLayout) onAddToLayout({ kind: "biplot", sampleId: activeSampleId, populationId: shown, xChannel: gate.x_channel, yChannel: gate.y_channel, displayMode: layoutDisplayMode });
            },
          },
          {
            label: t("Show this step on the Gating tab"),
            title: t("Open {population} on {x} against {y} on the Gating tab, where the gate can be edited", { population: state.populations[shown]?.name ?? "", x: gate.x_channel, y: gate.y_channel }),
            disabled: !onOpenStep,
            onClick: () => onOpenStep?.(shown, gate.x_channel, gate.y_channel),
          },
          "separator",
        ]
      : [];
    event.preventDefault();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      label: t("Gating strategy"),
      items: [
        { label: t("Add the strategy to the Layout tab"), title: strategyToLayoutTitle, disabled: !strategyRecipe() || !onAddToLayout, onClick: addStrategyToLayout },
        ...stepItems,
        { label: t("Fit data + gates"), title: t("Fit every plot shown here to its data and the gates on it"), onClick: () => onFitChannels(shownChannels.current) },
        "separator",
        { label: t("Export PNG"), onClick: () => void exportGridPNG("strategy-grid-container-grid", popName + "_strategy", exportDpi).catch(e => setRenderError(String(e))) },
        { label: t("Export SVG"), onClick: () => exportGridSVG("strategy-grid-container-grid", popName + "_strategy", exportDpi) },
        { label: t("Export PDF"), onClick: () => void exportGridPDF("strategy-grid-container-grid", popName + "_strategy", exportDpi).catch(e => setRenderError(String(e))) },
      ],
    });
  };
  const isContour = displayMode === "contour";
  const unit = isSceHost ? t("samples") : t("files");
  const poolNotes = poolReport
    ? [
        poolReport.omittedGates.length
          ? t("Gates not drawn: {names} (they differ between the pooled files)", { names: poolReport.omittedGates.join(", ") })
          : null,
        poolReport.leftOut.length
          ? t("Not pooled: {files}", { files: poolReport.leftOut.map((entry) => `${entry.name} (${entry.reason})`).join(", ") })
          : null,
        poolNote || null,
      ].filter((note): note is string => !!note)
    : [];
  const statusText = renderPending
    ? "Preparing strategy…"
    : !poolReady
      ? t("Preparing {count} {unit}…", { count: poolList.length, unit })
      : !panelCount
        ? pooled && !poolList.length
          ? t("Nothing is pooled: check the {unit} to pool in the file list.", { unit })
          : "Select a gated population to show its strategy."
        : pooled
          ? [t("{steps} strategy steps · {count} {unit} pooled", { steps: panelCount, count: poolReport?.drawn ?? poolList.length, unit }), ...poolNotes].join(" · ")
          : `${panelCount} strategy steps · current file and hierarchy`;
  const num = (setter: (n: number) => void, fallback: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setter(Number.isFinite(v) ? v : fallback);
  };

  return (
    <div className="gl-tab-panel gl-tab-fill">
      <div className="gl-strategy-controls"><strong>Gating strategy</strong><span>{pooled ? t("{count} {unit} pooled", { count: poolList.length, unit }) : sampleName} · {state.hierarchies.find(h => h.id === state.active_hierarchy_id)?.name}</span><span>Trace a gating path or back-gate selected populations.</span></div>
      <div className="gl-strategy-controls">
        <span className="gl-stats-opt-label">{t("Mode")}</span>
        {(["single", "multi"] as const).map((m) => (
          <label key={m} className="gl-check">
            <input type="radio" name="strat-scope" checked={mode === m} onChange={() => setMode(m)} />
            {m === "single" ? t("Single") : t("Multiple pops")}
          </label>
        ))}
        <span className="gl-ctl-sep" />
        {/* The Gating tab's own pool switch, here too: the strategy draws whatever the Gating tab pools. */}
        <label
          className="gl-check"
          title={t("Draw every step from the checked files' events together, as the Gating tab pools them: the point cap is shared out by population size, the counts are summed, and a gate is drawn where every pooled file has it alike")}
        >
          <input type="checkbox" checked={pooled} disabled={!pooled && !poolable} onChange={(e) => onPoolChange(e.target.checked)} />
          {isSceHost ? t("Pool checked samples") : t("Pool checked files")}
        </label>
        {mode === "single" && (<>
        <span className="gl-ctl-sep" />
        <label className="gl-field-inline">
          {t("Population")}
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
          {t("Full path from root")}
        </label>
        </>)}

        <span className="gl-ctl-sep" />
        <span className="gl-stats-opt-label">{t("Gate view")}</span>
        {(["forward", "back"] as GateView[]).map((v) => (
          <label key={v} className="gl-check">
            <input type="checkbox" checked={gateView.includes(v)} onChange={() => toggleGateView(v)} />
            {v === "forward" ? t("Forward") : t("Back-gated")}
          </label>
        ))}

      </div>

      <div className="gl-strategy-controls">
        <label className="gl-field-inline">
          {t("Max events/panel")}
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
          {t("All events")}
        </label>
        <span className="gl-ctl-sep" />
        <label className="gl-field-inline">
          {t("Plot size")}
          <input type="number" min={150} max={500} step={25} value={plotSize} onChange={(e) => setPlotSize(+e.target.value || 200)} />
        </label>
        <label className="gl-field-inline">
          {t("Columns")}
          <input type="number" min={1} max={12} value={nColumns} onChange={(e) => setNColumns(Math.max(1, +e.target.value || 4))} />
        </label>
        <label className="gl-check" title={t("Ticked: the plots, and their text in proportion, are drawn smaller than Plot size when the columns would not otherwise fit the width. Unticked: the plots are Plot size, and a wide strategy scrolls.")}>
          <input type="checkbox" checked={fitToColumns} onChange={(e) => setFitToColumns(e.target.checked)} />
          {t("Fit to columns")}
        </label>
        {mode === "multi" && fitToColumns && drawnSize !== null && drawnSize < plotSize && (
          <span className="gl-num-badge" title={t("Fit to columns drew the plots smaller than Plot size so the strategy fits the width; untick it to draw them at Plot size and scroll")}>
            {t("drawn at {size} px", { size: drawnSize })}
          </span>
        )}
        {mode === "multi" && (
          <label className="gl-field-inline" title={t("Tree: a column per depth and a row per traced population. Wrapped: the tree walked depth first and wrapped into rows of the columns above; the arrows say what leads to what.")}>
            {t("Layout")}
            <select value={layout} onChange={(e) => setLayout(e.target.value as "tree" | "flow")}>
              <option value="tree">{t("Tree")}</option>
              <option value="flow">{t("Wrapped")}</option>
            </select>
          </label>
        )}
        <span className="gl-ctl-sep" />
        <label className="gl-field-inline" title="Export resolution for SVG/PDF (72–1200 DPI)">
          DPI
          <input type="number" min={72} max={1200} step={1} value={exportDpi} onChange={(e) => setExportDpi(Math.max(72, Math.min(1200, Math.round(+e.target.value) || 300)))} />
        </label>
        <button
          className="gl-mini-btn"
          disabled={renderPending || !panelCount}
          title="Fit shown channels in the workspace Scales settings, including the current scale-lock scope"
          onClick={() => onFitChannels(shownChannels.current)}
        >{t("Fit data + gates")}</button>
        <button disabled={renderPending || !panelCount} className="gl-mini-btn" onClick={() => void exportGridPNG("strategy-grid-container-grid", popName + "_strategy", exportDpi).catch(e => setRenderError(String(e)))}>PNG</button>
        <button disabled={renderPending || !panelCount} className="gl-mini-btn" onClick={() => exportGridSVG("strategy-grid-container-grid", popName + "_strategy", exportDpi)}>SVG</button>
        <button disabled={renderPending || !panelCount} className="gl-mini-btn" onClick={() => void exportGridPDF("strategy-grid-container-grid", popName + "_strategy", exportDpi).catch(e => setRenderError(String(e)))}>PDF</button>
        {onAddToLayout && (
          <button type="button" className="gl-mini-btn" disabled={renderPending || !panelCount || !strategyRecipe()} title={strategyToLayoutTitle} onClick={addStrategyToLayout}>
            {t("Add to Layout")}
          </button>
        )}
      </div>

      <details><summary style={{ cursor: "pointer", padding: "8px 12px" }}>{t("Appearance")}</summary><div className="gl-strategy-controls">
        <span className="gl-stats-opt-label">{t("Display")}</span>
        {modeOpts.map((m) => (
          <label key={m.v} className="gl-check">
            <input type="radio" name="strat-mode" checked={displayMode === m.v} onChange={() => setDisplayMode(m.v)} />
            {t(m.l)}
          </label>
        ))}
        <span className="gl-ctl-sep" />
        <label className="gl-field-inline" title={t("The size of each drawn event, px")}>
          {t("Point size")}
          <input type="range" min={0.2} max={4} step={0.1} value={pointSize} onChange={num(setPointSize, 1.2)} />
          <span className="gl-num-badge">{pointSize.toFixed(1)}</span>
        </label>
        <label className="gl-field-inline">
          {t("Opacity")}
          <input type="range" min={0.05} max={1} step={0.05} value={pointAlpha} onChange={num(setPointAlpha, 0.35)} />
          <span className="gl-num-badge">{pointAlpha.toFixed(2)}</span>
        </label>
        {displayMode === "pseudocolor" && (
          <DensityColourControl value={densityColorPower} onChange={onDensityColorPowerChange} />
        )}
        {isContour && <label className="gl-field-inline" title={t("How many contour lines each panel draws")}>
          {t("Contours")}
          <select value={contourLevels} onChange={(e) => setContourLevels(+e.target.value)}>
            {[4, 6, 8, 10, 12, 18, 24, 30].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>}
        {isContour && <label className="gl-field-inline" title={t("The outer contour, as a percentage of the peak density")}>
          {t("Contour %")}
          <input type="number" min={0} max={50} step={1} value={contourThreshold} onChange={num(setContourThreshold, 5)} />
        </label>}
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
        <span className="gl-ctl-sep" />
        <label className="gl-check">
          <input type="checkbox" checked={pubStyle} onChange={(e) => setPubStyle(e.target.checked)} />
          {t("Publication style")}
        </label>
        <label className="gl-check" title={t("Gate labels in a bold face")}>
          <input type="checkbox" checked={gateLabelBold} onChange={(e) => setGateLabelBold(e.target.checked)} />
          {t("Bold gate labels")}
        </label>
        {pubStyle && (
          <label className="gl-field-inline" title={t("A white backing behind each plain gate label, so it reads on a dense pile of points; 0 for none")}>
            {t("Label backing")}
            <input type="range" min={0} max={1} step={0.05} value={labelBackground} onChange={(e) => setLabelBackground(Number(e.target.value))} />
            <span className="gl-num-badge">{Math.round(labelBackground * 100)}%</span>
          </label>
        )}
        {mode === "multi" && (
          <label className="gl-check" title={t("An arrow from each gate to the panel of the population it makes, routed between the panels; in the exports too")}>
            <input type="checkbox" checked={showArrows} onChange={(e) => setShowArrows(e.target.checked)} />
            {t("Arrows")}
          </label>
        )}
        {mode === "multi" && showArrows && (
          <label className="gl-field-inline" title={t("The arrows' line width, px; the heads grow with it")}>
            {t("Arrow width")}
            <input type="number" min={0.5} max={6} step={0.25} value={arrowWidth} onChange={num(setArrowWidth, 1.5)} />
          </label>
        )}
        {mode === "multi" && showArrows && (
          <label className="gl-field-inline" title={t("Where an arrow leaves its panel: level with the gate's label, or with the centre of the gate itself")}>
            {t("Arrows from")}
            <select value={arrowAnchor} onChange={(e) => setArrowAnchor(e.target.value === "gate" ? "gate" : "label")}>
              <option value="label">{t("Gate label")}</option>
              <option value="gate">{t("Gate centre")}</option>
            </select>
          </label>
        )}
        <label className="gl-field-inline">
          {t("Gate line")}
          <input type="number" min={0.5} max={5} step={0.25} value={gateLineWidth} onChange={num(setGateLineWidth, 1.5)} />
        </label>
        <label className="gl-field-inline" title={GATE_EDGE_MODES.find((m) => m.id === gateEdgeMode)?.hint}>
          {t("Gate edges")}
          <select value={gateEdgeMode} onChange={(e) => setGateEdgeMode(e.target.value as GateEdgeMode)}>
            {GATE_EDGE_MODES.map((m) => (
              <option key={m.id} value={m.id}>{t(m.label)}</option>
            ))}
          </select>
        </label>
        <span className="gl-ctl-sep" />
        <span className="gl-stats-opt-label">{t("Fonts")}</span>
        <label className="gl-field-inline">{t("Tick")}<input type="number" min={6} max={24} value={fontTick} onChange={num(setFontTick, 8)} /></label>
        <label className="gl-field-inline">{t("Axis")}<input type="number" min={6} max={28} value={fontAxis} onChange={num(setFontAxis, 10)} /></label>
        <label className="gl-field-inline">{t("Title")}<input type="number" min={6} max={28} value={fontTitle} onChange={num(setFontTitle, 10)} /></label>
        <label className="gl-field-inline">{t("Gate")}<input type="number" min={6} max={24} value={fontGate} onChange={num(setFontGate, 8)} /></label>
      </div></details>

      {mode === "multi" && (
        <StrategyPopulationPicker
          rows={selectablePops}
          populations={state.populations}
          gates={state.gates}
          counts={derived.stats?.event_count ?? {}}
          selected={multiPops}
          onChange={setMultiPops}
          checkedIds={state.selected_pop_ids}
        />
      )}
      {renderError && <p role="alert">{renderError}</p>}
      <p role="status">{statusText}</p>
      <div id="strategy-grid-container" ref={containerRef} aria-busy={renderPending} style={{ opacity: renderPending ? .5 : 1 }} className="gl-mini-grid-container" onContextMenu={openGridMenu} />
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

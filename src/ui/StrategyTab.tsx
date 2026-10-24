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
import { exportComposedPNG, exportComposedSVG, exportGridPNG, exportGridSVG, exportGridPDF } from "../plots/gridExport";
import { computeGatingStrategy, buildStrategyPayload, buildPooledStrategyPayload, type StrategyPart } from "../engine/strategy";
import { computeMultiPopStrategy, buildMultiStrategyPayload, flowLayout, tidyLayout } from "../engine/multiStrategy";
import { computePooledGatingStrategy, computePooledMultiPopStrategy, type StrategyLeftOut, type StrategyMember } from "../engine/pooledStrategy";
import { figureHierarchies, resolvePopulationInTree, type FigureSample } from "../engine/figure";
import { useFigureSources } from "./useFigureSources";
import { useGateInk } from "../plots/gateInk";
import { populationTreeOrder } from "../engine/populations";
import { sanitizeFilePart } from "../engine/fcsExport";
import type { LayoutPlotRecipe, LayoutStrategyRecipe } from "../engine/layout";
import type { StrategyConfig as SavedStrategyConfig } from "../engine/workspace";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import type { MenuEntry } from "./MenuButton";
import { StrategyPopulationPicker } from "./StrategyPopulationPicker";
import { drawStrategyArrows, strategyArrowGap, strategyArrowRowGap, strategyArrows } from "./strategyArrows";
import { attachGridPan, type PannablePanel } from "./gridPan";
import { DensityColourControl } from "./DensityColourControl";
import { useI18n } from "./i18n";
import { usePersistedTabState } from "./tabState";
import { composeStrategyTree, strategyTreeRows } from "./strategyTree";

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
  /**
   * The Gating tab's pool, in file order, when the Strategy tab is first opened; null while the
   * Gating tab draws one file. It seeds the Strategy tab's own pool, as the checked files seed the
   * Illustration tab's selection.
   */
  poolIds: readonly string[] | null;
  /** The files checked in the file list: the pool's first ticks, and "Use checked files". */
  checkedSampleIds: readonly string[];
  /** An SCE host's files are samples. */
  isSceHost?: boolean;
  /** View a file app-wide: the one file Strategy draws when nothing is pooled. */
  onViewFile: (id: string) => void;
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
  /** A selection an agent asked for (gatelab_view): taken once, whether the tab opens with it or is open already. */
  request?: StrategyRequest | null;
  /** The request with this nonce has been taken, so the App can drop it and a later remount restores the user's controls. */
  onRequestTaken?: (nonce: number) => void;
}

/** What an agent asks the tab to draw; the populations are checked against the active tree before it gets here. */
export interface StrategyRequest {
  nonce: number;
  mode: "single" | "multi";
  populationIds: string[];
  /** Single mode; the control is left as it is when absent. */
  fullPath?: boolean;
}

/**
 * The Strategy tab's controls as the workspace saves them: engine/workspace.ts's StrategyConfig,
 * and whether the exports carry the gating tree (absent reads as off). That one is declared here,
 * engine/ being frozen; the workspace writes the tab's config whole and reads it back as written,
 * so it is saved and restored with the others.
 */
export type StrategyConfig = SavedStrategyConfig & { exportTree?: boolean };

type GateView = StrategyConfig["gateView"][number];

/** The element the strategy grid is drawn in, which the exports compose. */
export const GRID_ID = "strategy-grid-container-grid";

/** The largest panel Fit to columns draws, as the Plot size field allows. */
const FIT_MAX_PLOT_SIZE = 500;
/**
 * Fit to columns: the panel size at which `columns` panels, `gap` apart, fill `width`; never under
 * the renderer's smallest panel (120 px), never over FIT_MAX_PLOT_SIZE.
 */
function fitPanelSize(width: number, columns: number, gap: number): number {
  return Math.max(120, Math.min(FIT_MAX_PLOT_SIZE, Math.floor((width - gap * (columns - 1)) / columns)));
}

/** Several populations, none ticked yet. */
const NOTHING_TICKED = "Tick populations in the Data tab to draw their strategy.";

const STRATEGY_SECTIONS = ["data", "plot", "style", "export"] as const;
type StrategySection = typeof STRATEGY_SECTIONS[number];
const STRATEGY_SECTION_LABELS: Record<StrategySection, string> = { data: "Data", plot: "Plot", style: "Style", export: "Export" };

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
  checkedSampleIds,
  isSceHost = false,
  onViewFile,
  activeSampleId,
  onAddToLayout,
  onOpenStep,
  onGateLabelMove,
  onScaleChange,
  request,
  onRequestTaken,
}: Props) {
  /** Channels of the plots most recently rendered, for Fit. */
  const shownChannels = useRef<readonly string[]>([]);
  const { t } = useI18n();
  const rootId = state.root_population_id ?? "";
  const c0 = configRef.current; // restore on (re)mount; null = first-ever
  const [section, setSection] = useState<StrategySection>("data");
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
  // The gates' look is the workspace's (gateInk.ts), set here or in any tab; a config's own
  // pubStyle, labelBackground and gateLineWidth are still written but no longer read.
  const ink = useGateInk();
  const pubStyle = !ink.coloured;
  const setPubStyle = (next: boolean) => ink.setColoured(!next);
  const [gateLabelBold, setGateLabelBold] = useState(c0?.gateLabelBold ?? false);
  const labelBackground = ink.labelBackground;
  const setLabelBackground = ink.setLabelBackground;
  const [layout, setLayout] = useState<"tree" | "flow">(c0?.layout ?? "tree");
  const gateLineWidth = ink.lineWidth;
  const setGateLineWidth = ink.setLineWidth;
  const [gateEdgeMode, setGateEdgeMode] = useState<GateEdgeMode>(c0?.gateEdgeMode ?? "straight-bow");
  const [fontTick, setFontTick] = useState(c0?.fontTick ?? 12);
  const [fontAxis, setFontAxis] = useState(c0?.fontAxis ?? 12);
  const [fontTitle, setFontTitle] = useState(c0?.fontTitle ?? 12);
  const [fontGate, setFontGate] = useState(c0?.fontGate ?? 12);
  const [exportTree, setExportTree] = useState(c0?.exportTree ?? false);

  // The files: one file is the file viewed app-wide, chosen in the list here as in the file list.
  // Pooled, the strategy draws the files ticked here, the Strategy tab's own selection, first
  // taken from the Gating tab's pool or checked files as the Illustration tab's is: each member
  // prepared as the Illustration tab prepares a file (cached across the tabs), the traced
  // population followed into each member's tree by lineage, so a tailored copy traces its own gates.
  const [pooled, setPooled] = usePersistedTabState<boolean>("strategy.pooled", () => poolIds !== null);
  const [poolTicks, setPoolTicks] = usePersistedTabState<string[]>("strategy.poolTicks", () => [...(poolIds ?? checkedSampleIds)]);
  const [fileSearch, setFileSearch] = useState("");
  const poolKey = pooled ? files.filter((file) => poolTicks.includes(file.id)).map((file) => file.id).join("|") : "";
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
  const gridShapeRef = useRef<{ rows: number; cols: number; plotSize: number; gap: number; rowGap: number; fonts: { tick: number; axis_label: number; gate_label: number; title: number } } | null>(null);
  /** The panel size the multi-population grid was last drawn at, shown beside Plot size when Fit made it smaller. */
  const [drawnSize, setDrawnSize] = useState<number | null>(null);
  const onScaleChangeRef = useRef(onScaleChange);
  onScaleChangeRef.current = onScaleChange;
  // Held in a ref, as the range handler is: the caller hands a new function at every render of
  // its own, and as a dependency of the draw below that redrew the whole grid whenever anything
  // else in the app changed (a save's status, a panel folded), which under a moving mouse showed
  // as the cursor flickering while the cells were replaced beneath it.
  const onGateLabelMoveRef = useRef(onGateLabelMove);
  onGateLabelMoveRef.current = onGateLabelMove;
  const labelsMovable = !!onGateLabelMove;
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

  // An agent's selection, taken in the render that receives it, so the commit that opens or
  // updates the tab already holds it (an effect's updates can land in a later render than the
  // App's own). The controls are set as the user sets them; nothing is dispatched.
  const [takenRequest, setTakenRequest] = useState<number | null>(null);
  const notifiedRequest = useRef<number | null>(null);
  if (request && request.nonce !== takenRequest) {
    setTakenRequest(request.nonce);
    setMode(request.mode);
    if (request.mode === "multi") setMultiPops([...request.populationIds]);
    else setPopId(request.populationIds[0]);
    if (request.fullPath !== undefined) setFullPath(request.fullPath);
  }

  // Follow the active population when it changes in the tree; in the commit that took an agent's
  // request, the request's population stands.
  useEffect(() => {
    if (takenRequest !== notifiedRequest.current) return;
    if (state.active_population_id) setPopId(state.active_population_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.active_population_id]);

  const onRequestTakenRef = useRef(onRequestTaken);
  onRequestTakenRef.current = onRequestTaken;
  useEffect(() => {
    if (takenRequest === null || takenRequest === notifiedRequest.current) return;
    notifiedRequest.current = takenRequest;
    onRequestTakenRef.current?.(takenRequest);
  }, [takenRequest]);

  // Mirror the controls into the App-held ref after each render so they persist across tab switches.
  const currentConfig: StrategyConfig = {
    mode, exportDpi, multiPops, popId, fullPath, gateView, displayMode, maxEvents, allEvents,
    plotSize, nColumns, fitToColumns, pointSize, pointAlpha, contourThreshold, contourLevels, kdeBandwidth,
    pubStyle, gateLineWidth, gateEdgeMode, gateLabelBold, labelBackground, showArrows, arrowWidth, arrowAnchor, layout, fontTick, fontAxis, fontTitle, fontGate,
    exportTree,
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
      const onLabelMove = labelsMovable
        ? (gateId: string, offset: [number, number], quadrant?: number) => onGateLabelMoveRef.current?.(state.active_hierarchy_id, gateId, offset, quadrant)
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
        // Fit ticked: the panels are sized so the grid's columns fill the width (fitPanelSize). Where
        // that is smaller than Plot size the text is drawn smaller by the same ratio, so a fitted
        // strategy is the strategy at Plot size seen smaller rather than small panels under
        // full-size labels. Unticked: the panels are Plot size, and a strategy wider than the pane
        // scrolls.
        // The gutters are as wide as the busiest one's lines need, so lines that run side by side
        // stay apart.
        const arrows = showArrows ? strategyArrows(nodes, state.populations) : [];
        const gridGap = showArrows ? strategyArrowGap(arrows) : 8;
        // The rows sit close unless a line runs between them, which a tree's never do.
        const gridRowGap = showArrows ? strategyArrowRowGap(arrows) : 8;
        const gridCols = nodes.length ? Math.max(...nodes.map((node) => node.col)) + 1 : 1;
        const fitted = fitToColumns && availableWidth > 0 ? fitPanelSize(availableWidth - 8, gridCols, gridGap) : plotSize;
        const fontScale = fitted < plotSize ? fitted / plotSize : 1;
        const scaled = (size: number) => Math.max(5, Math.round(size * fontScale * 10) / 10);
        const gridFonts = fontScale < 1
          ? { tick: scaled(fontSizes.tick), axis_label: scaled(fontSizes.axis_label), gate_label: scaled(fontSizes.gate_label), title: scaled(fontSizes.title) }
          : fontSizes;
        gridShapeRef.current = nodes.length
          ? { rows: Math.max(...nodes.map((node) => node.row)) + 1, cols: gridCols, plotSize: fitted, fonts: gridFonts, gap: gridGap, rowGap: gridRowGap }
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
          gridRowGap: showArrows ? gridRowGap : undefined,
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
        // With nothing ticked, the renderer's own note points at a selector and a Render button
        // this tab does not have; it draws as soon as a population is ticked.
        loadMiniPlots().renderMultiStrategyGrid("strategy-grid-container", nodes.length ? payload : { ...payload, error_msg: t(NOTHING_TICKED) });
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
      // Fit ticked: the steps' columns, no more than there are steps, fill the width, as in the
      // multi-population grid; the renderer is then given that size rather than fitting again.
      const columns = Math.max(1, Math.min(nColumns, steps.length));
      const fitted = fitToColumns && availableWidth > 0 ? fitPanelSize(availableWidth - 8, columns, 8) : plotSize;
      const fontScale = fitted < plotSize ? fitted / plotSize : 1;
      const scaled = (size: number) => Math.max(5, Math.round(size * fontScale * 10) / 10);
      setDrawnSize(fitted);
      const payloadOptions = {
        gateView,
        displayMode: effMode,
        maxEvents: cap,
        nColumns,
        plotSize: fitted,
        fitToColumns: false,
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
        fontSizes: fontScale < 1
          ? { tick: scaled(fontSizes.tick), axis_label: scaled(fontSizes.axis_label), gate_label: scaled(fontSizes.gate_label), title: scaled(fontSizes.title) }
          : fontSizes,
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
      // The width matters only where the panels are fitted to it.
      state.gates, state.gate_version, globalScales, derived, dataRevision, fitToColumns ? availableWidth : 0, pooled, members, trees, labelsMovable]);

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
  /**
   * The gating tree the exports carry when asked: the populations drawn and their ancestors, with
   * this file's counts. Pooled, the panels sum several files, so no tree is written.
   */
  const treePage = () => {
    if (!exportTree || pooled) return null;
    const rows = strategyTreeRows(state.populations, rootId, mode === "multi" ? multiPops : [popId], derived.masks, sample.fcs.nEvents);
    return rows.length ? composeStrategyTree(rows, { title: ["Gating tree", sampleName].filter((part) => !!part).join(" · "), fontSize: fontTitle }) : null;
  };
  /** The strategy as PNG, SVG or PDF; with the tree as the PDF's second page, or as a second file named "<strategy>_tree". */
  const exportStrategy = async (format: "png" | "svg" | "pdf") => {
    const name = popName + "_strategy";
    try {
      const tree = treePage();
      if (format === "pdf") {
        await exportGridPDF(GRID_ID, name, exportDpi, tree ? [tree] : []);
        return;
      }
      if (format === "png") await exportGridPNG(GRID_ID, name, exportDpi);
      else exportGridSVG(GRID_ID, name, exportDpi);
      if (!tree) return;
      if (format === "png") await exportComposedPNG(tree, name + "_tree", exportDpi);
      else exportComposedSVG(tree, name + "_tree");
    } catch (e) {
      setRenderError(String(e));
    }
  };
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
    const rowGap = shape.rowGap, trailingBelow = showArrows ? rowGap : 4;
    const grid = containerRef.current?.querySelector<HTMLElement>(".multi-strategy-grid");
    const title = containerRef.current?.querySelector<HTMLElement>(".strategy-context-title");
    const width = grid && grid.offsetWidth > 0 ? grid.offsetWidth : shape.cols * shape.plotSize + (shape.cols - 1) * gap + 4 + trailing;
    const height = (grid && grid.offsetHeight > 0 ? grid.offsetHeight : shape.rows * shape.plotSize + (shape.rows - 1) * rowGap + 4 + trailingBelow) + (title && title.offsetHeight > 0 ? title.offsetHeight + 6 : 26);
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
        { label: t("Export PNG"), onClick: () => void exportStrategy("png") },
        { label: t("Export SVG"), onClick: () => void exportStrategy("svg") },
        { label: t("Export PDF"), onClick: () => void exportStrategy("pdf") },
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
      ].filter((note): note is string => !!note)
    : [];
  const statusText = renderPending
    ? "Preparing strategy…"
    : !poolReady
      ? t("Preparing {count} {unit}…", { count: poolList.length, unit })
      : !panelCount
        ? pooled && !poolList.length
          ? t("Nothing is pooled: tick the {unit} to pool in the list.", { unit })
          : mode === "multi" ? t(NOTHING_TICKED) : "Select a gated population to show its strategy."
        : pooled
          ? [t("{steps} strategy steps · {count} {unit} pooled", { steps: panelCount, count: poolReport?.drawn ?? poolList.length, unit }), ...poolNotes].join(" · ")
          : `${panelCount} strategy steps · current file and hierarchy`;
  const num = (setter: (n: number) => void, fallback: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setter(Number.isFinite(v) ? v : fallback);
  };

  /** What is drawn, in the heading: the file or the pool, and the tree. */
  const headContext = `${pooled ? t("{count} {unit} pooled", { count: poolList.length, unit }) : sampleName} · ${state.hierarchies.find(h => h.id === state.active_hierarchy_id)?.name ?? ""}`;
  return (
    <div className="gl-tab-panel gl-tab-fill gl-plotting-workspace gl-strategy-workspace">
      <div className="gl-plotting-head">
        <strong>{t("Gating strategy")}</strong>
        <span title={headContext}>{headContext}</span>
        <span title={t("Trace a gating path or back-gate selected populations.")}>{t("Trace a gating path or back-gate selected populations.")}</span>
      </div>
      {/* The side tabs Illustration and Plotting have: what to draw first, then how it looks. */}
      <aside className="gl-plotting-inspector gl-strategy-inspector" aria-label={t("Strategy controls")}>
        <nav className="gl-presentation-tabs" aria-label={t("Strategy settings")}>
          {STRATEGY_SECTIONS.map((id) => (
            <button key={id} type="button" aria-pressed={section === id} onClick={() => setSection(id)}>
              {t(STRATEGY_SECTION_LABELS[id])}
            </button>
          ))}
        </nav>
        <section className="gl-strategy-section" hidden={section !== "data"} aria-label={t("Data")}>
          <h3>{t("Mode")}</h3>
          {(["single", "multi"] as const).map((m) => (
            <label key={m} className="gl-check">
              <input type="radio" name="strat-scope" checked={mode === m} onChange={() => setMode(m)} />
              {m === "single" ? t("Single") : t("Multiple pops")}
            </label>
          ))}
          {/* Several populations are chosen here, the Strategy tab's own selection: not the
              Populations pane's ticks, which belong to the Gating tab. */}
          {mode === "multi" && (
            <StrategyPopulationPicker
              compact
              rows={selectablePops}
              populations={state.populations}
              gates={state.gates}
              counts={derived.stats?.event_count ?? {}}
              selected={multiPops}
              onChange={setMultiPops}
            />
          )}
          {mode === "single" && (<>
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
          <h3>
            {t("Files / samples")}
            {pooled && <span>{t("{selected} of {total} selected", { selected: poolList.length, total: files.length })}</span>}
          </h3>
          <label
            className="gl-check"
            title={t("Draw every step from the checked files' events together, as the Gating tab pools them: the point cap is shared out by population size, the counts are summed, and a gate is drawn where every pooled file has it alike")}
          >
            <input type="checkbox" checked={pooled} onChange={(e) => setPooled(e.target.checked)} />
            {isSceHost ? t("Pool checked samples") : t("Pool checked files")}
          </label>
          {pooled && (
            <div className="gl-figure-actions gl-figure-list-actions">
              <button type="button" className="gl-mini-btn" onClick={() => setPoolTicks([...checkedSampleIds])}>{t("Use checked files")}</button>
              <button type="button" className="gl-mini-btn" onClick={() => setPoolTicks(files.map((file) => file.id))}>{t("All")}</button>
              <button type="button" className="gl-mini-btn" onClick={() => setPoolTicks([])}>{t("None")}</button>
            </div>
          )}
          {files.length > 6 && (
            <input
              type="search"
              className="gl-strategy-file-search"
              aria-label={t("Find file / sample…")}
              placeholder={t("Find file / sample…")}
              value={fileSearch}
              onChange={(e) => setFileSearch(e.target.value)}
            />
          )}
          {/* One file: a choice of the file viewed, as clicking it in the file list makes it.
              Pooled: the files ticked to pool. */}
          <div className="gl-figure-list gl-strategy-files" role={pooled ? "group" : "radiogroup"} aria-label={t("Files / samples")}>
            {files
              .filter((file) => `${file.name} ${file.fileName ?? ""}`.toLowerCase().includes(fileSearch.trim().toLowerCase()))
              .map((file) => (
                <label key={file.id} className="gl-figure-row" title={file.fileName && file.fileName !== file.name ? `${file.name} · ${file.fileName}` : file.name}>
                  {pooled ? (
                    <input
                      type="checkbox"
                      checked={poolTicks.includes(file.id)}
                      onChange={() => setPoolTicks((ticks) => (ticks.includes(file.id) ? ticks.filter((id) => id !== file.id) : [...ticks, file.id]))}
                    />
                  ) : (
                    <input type="radio" name="strategy-file" checked={file.id === activeSampleId} onChange={() => onViewFile(file.id)} />
                  )}
                  <span className="gl-figure-row-name">{file.name}{file.fileName && file.fileName !== file.name && <small>{file.fileName}</small>}</span>
                </label>
              ))}
          </div>
          <h3>{t("Gate view")}</h3>
          {(["forward", "back"] as GateView[]).map((v) => (
            <label key={v} className="gl-check">
              <input type="checkbox" checked={gateView.includes(v)} onChange={() => toggleGateView(v)} />
              {v === "forward" ? t("Forward") : t("Back-gated")}
            </label>
          ))}
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
        </section>
        <section className="gl-strategy-section" hidden={section !== "plot"} aria-label={t("Plot")}>
          <label className="gl-field-inline">
            {t("Plot size")}
            {/* A size typed here is the size wanted: Fit to columns, which would draw the plots
                smaller to fit the width whatever is typed, is switched off with it. */}
            <input type="number" min={150} max={500} step={25} value={plotSize} onChange={(e) => { setPlotSize(+e.target.value || 200); setFitToColumns(false); }} />
          </label>
          <label className="gl-field-inline">
            {t("Columns")}
            <input type="number" min={1} max={12} value={nColumns} onChange={(e) => setNColumns(Math.max(1, +e.target.value || 4))} />
          </label>
          <label className="gl-check" title={t("Ticked: the plots are sized so the columns fill the width, up to 500 px, and their text drawn smaller in proportion where they are smaller than Plot size. Unticked: the plots are Plot size, and a wide strategy scrolls.")}>
            <input type="checkbox" checked={fitToColumns} onChange={(e) => setFitToColumns(e.target.checked)} />
            {t("Fit to columns")}
          </label>
          {fitToColumns && drawnSize !== null && drawnSize !== plotSize && (
            <span className="gl-num-badge" title={t("Fit to columns drew the plots at this size so the strategy fills the width; untick it to draw them at Plot size")}>
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
          <button
            className="gl-mini-btn"
            disabled={renderPending || !panelCount}
            title="Fit shown channels in the workspace Scales settings, including the current scale-lock scope"
            onClick={() => onFitChannels(shownChannels.current)}
          >{t("Fit data + gates")}</button>
        </section>
        <section className="gl-strategy-section" hidden={section !== "style"} aria-label={t("Style")}>
          <h3>{t("Display")}</h3>
          {modeOpts.map((m) => (
            <label key={m.v} className="gl-check">
              <input type="radio" name="strat-mode" checked={displayMode === m.v} onChange={() => setDisplayMode(m.v)} />
              {t(m.l)}
            </label>
          ))}
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
          <label className="gl-check" title={t("The workspace's setting, the same as the Gating tab's Display: off draws every gate and its label in black")}>
            <input type="checkbox" className="gl-coloured-gates-mirror" checked={!pubStyle} onChange={(e) => setPubStyle(!e.target.checked)} />
            {t("Coloured gates")}
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
          <h3>{t("Fonts")}</h3>
          <label className="gl-field-inline">{t("Tick")}<input type="number" min={6} max={24} value={fontTick} onChange={num(setFontTick, 8)} /></label>
          <label className="gl-field-inline">{t("Axis")}<input type="number" min={6} max={28} value={fontAxis} onChange={num(setFontAxis, 10)} /></label>
          <label className="gl-field-inline">{t("Title")}<input type="number" min={6} max={28} value={fontTitle} onChange={num(setFontTitle, 10)} /></label>
          <label className="gl-field-inline">{t("Gate")}<input type="number" min={6} max={24} value={fontGate} onChange={num(setFontGate, 8)} /></label>
        </section>
        <section className="gl-strategy-section" hidden={section !== "export"} aria-label={t("Export")}>
          <label className="gl-field-inline" title="Export resolution for SVG/PDF (72–1200 DPI)">
            DPI
            <input type="number" min={72} max={1200} step={1} value={exportDpi} onChange={(e) => setExportDpi(Math.max(72, Math.min(1200, Math.round(+e.target.value) || 300)))} />
          </label>
          <label
            className="gl-check"
            title={pooled
              ? t("The gating tree gives one file's counts, so it is not exported while files are pooled")
              : t("The exports carry the gating tree: the populations drawn and their ancestors in tree order, each with its event count and % of parent. In a PDF it is the second page; with a PNG or SVG it is a second file, named as the strategy's with _tree added.")}
          >
            <input type="checkbox" checked={exportTree} disabled={pooled} onChange={(e) => setExportTree(e.target.checked)} />
            {t("With gating tree")}
          </label>
          <button disabled={renderPending || !panelCount} className="gl-mini-btn" onClick={() => void exportStrategy("png")}>PNG</button>
          <button disabled={renderPending || !panelCount} className="gl-mini-btn" onClick={() => void exportStrategy("svg")}>SVG</button>
          <button disabled={renderPending || !panelCount} className="gl-mini-btn" onClick={() => void exportStrategy("pdf")}>PDF</button>
          {onAddToLayout && (
            <button type="button" className="gl-mini-btn" disabled={renderPending || !panelCount || !strategyRecipe()} title={strategyToLayoutTitle} onClick={addStrategyToLayout}>
              {t("Add to Layout")}
            </button>
          )}
        </section>
      </aside>
      <div className="gl-prop-body gl-strategy-body">
        {renderError && <p role="alert">{renderError}</p>}
        <p role="status">{statusText}</p>
        {/* data-state tells an agent's render when the grid is finished, or why there is none. */}
        <div
          id="strategy-grid-container" ref={containerRef} aria-busy={renderPending} style={{ opacity: renderPending ? .5 : 1 }} className="gl-mini-grid-container" onContextMenu={openGridMenu}
          data-state={renderPending ? "drawing" : !poolReady ? "preparing" : renderError ? "error" : panelCount ? "drawn" : "empty"}
        />
      </div>
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

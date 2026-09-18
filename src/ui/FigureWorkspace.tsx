import { useEffect, useMemo, useRef, useState, type MutableRefObject, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import type { MenuEntry } from "./MenuButton";
import { SearchableSelect } from "./SearchableSelect";
import { renderToStaticMarkup } from "react-dom/server";
import type { CoreState } from "../store";
import type {
  IllustrationConfig,
  IllustrationPreset,
} from "../engine/workspace";
import {
  buildFigurePanel,
  canonicalGateId,
  canonicalPopulation,
  figureLabelKey,
  captureFigureTransforms,
  figureHierarchies,
  figurePopulationOptions,
  figurePopulationApplies,
  layoutFigure,
  migrateFigure,
  resolveFigurePopulation,
  type FigureDimension,
  type FigurePanel,
  type FigurePopulation,
  type FigureSample,
  type FigureSpec,
  type FigurePage,
  type FigurePanelData, type FigureValue } from "../engine/figure";
import {
  defaultIllustrationConfig,
  figureStyle,
} from "../engine/figureDefaults";
import {
  FigureGrid,
  styledFigurePlot,
  colourFigureSummaries,
} from "./FigureGrid";
import { useFigureSources } from "./useFigureSources";
import { treeLabelMove } from "../engine/illustration";
import { facetColumns, groupCheckedCount, toggleGroupChecked } from "../engine/sampleFacets";
import type { LayoutDisplayMode, LayoutGridCell, LayoutGridHeading, LayoutGridHeadings, LayoutPlotRecipe } from "../engine/layout";

/** The placeholder a Layout text block reads for a figure dimension's heading, or null for one it cannot (a page). */
function headingTemplate(dimension: FigureDimension): string | null {
  if (dimension === "samples") return "{sample}";
  if (dimension === "populations") return "{population}";
  if (dimension === "plots") return "{plot}";
  if (dimension.startsWith("metadata:")) return `{meta:${dimension.slice("metadata:".length)}}`;
  if (dimension.startsWith("popmeta:")) return `{popmeta:${dimension.slice("popmeta:".length)}}`;
  return null;
}
import { useFigurePanels } from "./useFigurePanels";
import { OrderList } from "./OrderList";
import { populationTreeOrder } from "../engine/populations";
import {
  exportGridPDF,
  exportGridPNG,
  exportGridSVG,
} from "../plots/gridExport";
import { drawFigurePlot } from "../plots/figurePlot";
import { sanitizeFilePart } from "../engine/fcsExport";
import { GATE_EDGE_MODES, type GateEdgeMode } from "./gateEdgeModes";
import "./figure.css";
import { NumberField } from "./NumberField";

interface Props {
  samples: readonly FigureSample[];
  checkedSampleIds: string[];
  state: CoreState;
  defaultX: string;
  defaultY: string;
  configRef: MutableRefObject<IllustrationConfig | null>;
  presets: IllustrationPreset[];
  onSavePreset: (name: string) => void;
  onDeletePreset: (name: string) => void;
  onConfigChange: () => void;
  onOpenGating: () => void;
  dataRevision: string | number;
  /** The Gating tab's per-channel ranges, for the "As on the Gating tab" axis policy. */
  globalScales?: Record<string, [number, number]>;
  /** Fit these channels to their data and gates on the Gating tab's own range map. */
  onFitChannels?: (keys: readonly string[]) => void;
  /** Put the figure's plots, one per file and plot, on the Layout tab. */
  /** Plots for the Layout tab; with `cells`, one per recipe, they keep their arrangement there. */
  onAddToLayout?: (recipes: LayoutPlotRecipe[], cells?: readonly LayoutGridCell[], headings?: LayoutGridHeadings) => void;
  /** Put the whole figure, as it is, on the Layout tab as one block. */
  onAddFigureToLayout?: (config: IllustrationConfig) => void;
  /** Show a panel's file, population and channels on the Gating tab. */
  onOpenInGating?: (recipe: LayoutPlotRecipe) => void;
  /** The Metadata tab's population table, by population id: groupings the Arrange tab can offer. */
  populationMetadata?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * A gate label was dragged: place it in the store, for the gate named in the tree named, in
   * the gate's own orientation. The store carries it to every tree the gate is drawn in, so the
   * Gating and Layout tabs show the same placement. Without this the figure keeps the placement.
   */
  onGateLabelMove?: (hierarchyId: string, gateId: string, offset: [number, number], quadrant?: number) => void;
}
const refKey = (ref: FigurePopulation) =>
  JSON.stringify([ref.hierarchyId, ref.populationId]);
const dimensionLabel = (dimension: FigureDimension) =>
  dimension === "samples"
    ? "files / samples"
    : dimension.startsWith("popmeta:")
      ? `populations by ${dimension.slice(8)}`
      : dimension.replace("metadata:", "");
function move<T>(items: T[], index: number, offset: number) {
  const result = [...items],
    target = index + offset;
  if (target >= 0 && target < items.length)
    [result[index], result[target]] = [result[target], result[index]];
  return result;
}

export function FigureWorkspace({
  samples,
  checkedSampleIds,
  state,
  populationMetadata,
  defaultX,
  defaultY,
  configRef,
  presets,
  onSavePreset,
  onDeletePreset,
  onConfigChange,
  onOpenGating,
  dataRevision,
  globalScales,
  onFitChannels,
  onAddToLayout,
  onAddFigureToLayout,
  onOpenInGating,
  onGateLabelMove,
}: Props) {
  const trees = figureHierarchies(state);
  // The inspector's width is the user's: dragged, kept for the session.
  const [inspectorWidth, setInspectorWidthState] = useState(() => {
    const saved = Number(configRef.current?.inspectorWidth);
    return Number.isFinite(saved) && saved > 0 ? Math.max(220, Math.min(600, saved)) : 290;
  });
  // The width is the user's, so it saves with the figure.
  const setInspectorWidth = (next: number | ((current: number) => number)) => {
    const value = typeof next === "function" ? next(inspectorWidth) : next;
    setInspectorWidthState(value);
    change({ ...(configRef.current ?? config), inspectorWidth: value });
  };
  const inspectorDrag = useRef<{ x: number; w: number } | null>(null);
  const [config, setConfig] = useState<IllustrationConfig>(() => {
    const legacy = configRef.current,
      initial = samples.filter((s) => checkedSampleIds.includes(s.id));
    return {
      ...defaultIllustrationConfig(),
      ...legacy,
      figure: migrateFigure(
        legacy,
        initial.length ? initial : samples,
        trees,
        state.active_hierarchy_id,
        defaultX,
        defaultY,
      ),
      scaleFontsWithPlot: legacy?.scaleFontsWithPlot ?? false,
    };
  });
  const figure = config.figure!;
  const [section, setSection] = useState("data"),
    [search, setSearch] = useState(""),
    [populationSearch, setPopulationSearch] = useState("");
  const [panelMenu, setPanelMenu] = useState<ContextMenuState | null>(null);
  // Panels chosen by clicking them: what "Add selected panels to the Layout tab" takes. A plain
  // click chooses one, Cmd or Ctrl adds or removes, Shift takes the block between; Escape clears.
  const [selectedPanelKeys, setSelectedPanelKeys] = useState<ReadonlySet<string>>(() => new Set());
  const selectionAnchor = useRef<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0),
    [zoom, setZoom] = useState("fit"),
    [previewWidth, setPreviewWidth] = useState(800);
  const [paperWidth, setPaperWidth] = useState(0);
  const paper = useRef<HTMLDivElement>(null);
  const [exportFormat, setExportFormat] = useState("svg"),
    [exportDpi, setExportDpi] = useState(300),
    [exportAll, setExportAll] = useState(true);
  const [exporting, setExporting] = useState(false),
    [exportError, setExportError] = useState("");
  const [presetName, setPresetName] = useState(""),
    [preset, setPreset] = useState("");
  const [history, setHistory] = useState<IllustrationConfig[]>([]),
    [future, setFuture] = useState<IllustrationConfig[]>([]);
  const viewport = useRef<HTMLDivElement>(null),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  function change(next: IllustrationConfig) {
    setHistory((h) => [...h.slice(-29), config]);
    setFuture([]);
    setConfig(next);
    setExportError("");
  }
  function editFigure(patch: Partial<FigureSpec>) {
    change({
      ...config,
      figure: captureFigureTransforms({ ...figure, ...patch }, samples),
    });
  }
  function style(patch: Partial<IllustrationConfig>) {
    change({ ...config, ...patch });
  }
  // A figure saved before placements were the gates' own kept them for itself; they move into
  // the store once, under the gate they descend from, so the Gating tab shows them too and
  // every tab agrees from then on. A placement whose gate is gone has nowhere to go.
  const legacyPlacementsMoved = useRef(false);
  useEffect(() => {
    const offsets = figure.labelOffsets;
    if (legacyPlacementsMoved.current || !onGateLabelMove || !offsets || !Object.keys(offsets).length) return;
    legacyPlacementsMoved.current = true;
    for (const [key, offset] of Object.entries(offsets)) {
      const [canonical, q] = key.split("#q");
      const quadrant = q === undefined ? undefined : Number(q);
      // The tree holding the original itself, else any tree with a copy of it.
      const all = Object.values(trees);
      const home = all.find((tree) => tree.gates[canonical] && canonicalGateId(canonical, tree, trees) === canonical);
      const found = home
        ? { tree: home, gateId: canonical }
        : all.flatMap((tree) => Object.keys(tree.gates).filter((id) => canonicalGateId(id, tree, trees) === canonical).map((gateId) => ({ tree, gateId })))[0];
      if (found) onGateLabelMove(found.tree.id, found.gateId, offset, quadrant);
    }
    editFigure({ labelOffsets: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [figure.labelOffsets, onGateLabelMove]);
  const lastConfig = useRef(configRef.current);
  useEffect(() => {
    configRef.current = config;
    if (lastConfig.current !== config) {
      lastConfig.current = config;
      onConfigChange();
    }
  }, [config, configRef, onConfigChange]);
  useEffect(() => {
    if (!viewport.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) =>
      setPreviewWidth(entries[0].contentRect.width),
    );
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  // Refresh rebuilds every panel from the current gates, files and the Gating tab's axes.
  const [refreshTick, setRefreshTick] = useState(0);
  const prepared = useFigureSources(
    samples,
    figure.sampleIds,
    state,
    `${dataRevision}|${refreshTick}`,
  );
  const layoutKey = JSON.stringify([
    figure.sampleIds,
    figure.populations,
    figure.plots,
    figure.rows,
    figure.columns,
    figure.pages,
    figure.composition,
    figure.overlayPopulations,
    figure.populationOverrides,
    samples.map((s) => [s.id, s.name, s.metadata, s.hierarchyId]),
    Object.values(trees).map((t) => [
      t.id,
      t.owner_sample_id,
      t.source_hierarchy_id,
      t.source_population_ids,
      Object.keys(t.populations),
    ]),
  ]);
  const layout = useMemo(() => {
    try {
      const pages = layoutFigure(figure, samples, trees, populationMetadata);
      if (pages.some((page) => page.panels.length > 256))
        throw new Error(
          "This page has more than 256 panels. Move Files / samples or Populations to Pages in Arrange, or select fewer items.",
        );
      return {
        pages,
        error: "",
      };
    } catch (error) {
      return {
        pages: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [layoutKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const pages = layout.pages;
  const currentPage = Math.min(pageIndex, Math.max(0, pages.length - 1)),
    page = pages[currentPage];
  const built = useFigurePanels(
    page,
    figure,
    prepared.sources,
    trees,
    prepared.pending > 0 || !prepared.current,
    config.maxEvents,
    config.heatmapStat,
    globalScales ?? {},
    refreshTick,
  );
  const panelData = useMemo(
    () => (page ? colourFigureSummaries(page, built.data, config) : built.data),
    [page, built.data, config.heatmapScale, config.heatmapPalette],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const pending = prepared.pending > 0 || built.pending;
  // The last figure drawn in full stays on screen while a rebuild is pending, so an edit to a
  // plot does not blank its cells until the new panels land: a panel whose key changed had no
  // data yet and showed its placeholder, a white flash on every edit. The dim that marks the
  // wait is held back until the rebuild has run long enough to notice, for the same reason.
  const lastComplete = useRef<{ page: FigurePage; panels: Record<string, FigurePanelData> } | null>(null);
  useEffect(() => {
    if (!pending && page) lastComplete.current = { page, panels: panelData };
  }, [pending, page, panelData]);
  const shown = pending && page && lastComplete.current ? lastComplete.current : page ? { page, panels: panelData } : null;
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    if (!pending) {
      setSettling(false);
      return;
    }
    const timer = setTimeout(() => setSettling(true), 400);
    return () => clearTimeout(timer);
  }, [pending]);
  useEffect(() => {
    if (!paper.current || typeof ResizeObserver === "undefined") return;
    const element = paper.current;
    const observer = new ResizeObserver(() =>
      setPaperWidth(element.offsetWidth),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [page?.key, pending]);
  /** Layout plots for these panels: one per file and plot of each, the population followed into the file's tree. */
  /**
   * The Layout recipes for panels, with the cell each takes in a grid that keeps the panels'
   * arrangement: rows and columns as here, closed up to the block they span.
   */
  const placedRecipesFor = (targets: readonly FigurePanel[]): { recipes: LayoutPlotRecipe[]; cells: LayoutGridCell[]; headings: LayoutGridHeadings } => {
    const rows = [...new Set(targets.map((p) => p.row))].sort((a, b) => a - b);
    const columns = [...new Set(targets.map((p) => p.column))].sort((a, b) => a - b);
    const recipes: LayoutPlotRecipe[] = [];
    const cells: LayoutGridCell[] = [];
    for (const panel of targets) {
      for (const recipe of layoutRecipesFor([panel])) {
        recipes.push(recipe);
        cells.push({ row: rows.indexOf(panel.row), column: columns.indexOf(panel.column) });
      }
    }
    // The figure's headings go along as text that reads the first plot of its row or column,
    // so a column headed by a file's condition still reads it there; a heading with no
    // placeholder (a page) is carried as written. One row or one column needs no heading.
    const headingOf = (values: readonly FigureValue[]): LayoutGridHeading => {
      const templates = values.map((value) => headingTemplate(value.dimension));
      return { text: values.map((value) => value.label).join(" · "), ...(templates.every(Boolean) ? { template: templates.join(" · ") } : {}) };
    };
    const headings: LayoutGridHeadings = {
      columns: columns.length > 1 && page ? columns.map((column) => headingOf(page.columns[column] ?? [])) : [],
      rows: rows.length > 1 && page ? rows.map((row) => headingOf(page.rows[row] ?? [])) : [],
    };
    return { recipes, cells, headings };
  };
  const addPanelsToLayout = (targets: readonly FigurePanel[]) => {
    const placed = placedRecipesFor(targets);
    if (placed.recipes.length) onAddToLayout?.(placed.recipes, placed.cells, placed.headings);
  };
  const selectedPanels = page ? page.panels.filter((p) => selectedPanelKeys.has(p.key)) : [];
  const onPanelClick = (panel: FigurePanel, event: ReactMouseEvent<HTMLElement>) => {
    const key = panel.key;
    setSelectedPanelKeys((current) => {
      const next = new Set(current);
      if (event.shiftKey && selectionAnchor.current && page) {
        const anchor = page.panels.find((p) => p.key === selectionAnchor.current);
        if (anchor) {
          const [r0, r1] = [Math.min(anchor.row, panel.row), Math.max(anchor.row, panel.row)];
          const [c0, c1] = [Math.min(anchor.column, panel.column), Math.max(anchor.column, panel.column)];
          if (!event.metaKey && !event.ctrlKey) next.clear();
          for (const p of page.panels) if (p.row >= r0 && p.row <= r1 && p.column >= c0 && p.column <= c1) next.add(p.key);
          return next;
        }
      }
      if (event.metaKey || event.ctrlKey) {
        if (next.has(key)) next.delete(key);
        else next.add(key);
      } else if (next.size === 1 && next.has(key)) {
        next.clear();
      } else {
        next.clear();
        next.add(key);
      }
      return next;
    });
    if (!event.shiftKey) selectionAnchor.current = key;
  };
  useEffect(() => {
    // Another page is other panels.
    setSelectedPanelKeys(new Set());
  }, [page?.key]);
  useEffect(() => {
    if (!selectedPanelKeys.size) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedPanelKeys(new Set());
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedPanelKeys.size]);
  // Drag across the page to select the panels the band crosses. A press on a gate label is the
  // label's own drag (it stops the mousedown), and a press on a control is the control's. The
  // band replaces the selection, or adds to it with Cmd, Ctrl or Shift; a press that does not move
  // is left to the panel's click, and on blank paper it clears.
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const startMarquee = (event: ReactMouseEvent<HTMLDivElement>) => {
    const vp = viewport.current;
    if (event.button !== 0 || !page || !vp) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, select, textarea, a, [contenteditable='true']")) return;
    event.preventDefault();
    const onPanel = !!target.closest("td[data-figure-panel]");
    const additive = event.metaKey || event.ctrlKey || event.shiftKey;
    const before: ReadonlySet<string> = additive ? new Set(selectedPanelKeys) : new Set();
    const keys = new Set(page.panels.map((p) => p.key));
    const start = vp.getBoundingClientRect();
    // The origin is kept in the viewport's content coordinates, so scrolling mid-drag holds it.
    const origin = [event.clientX - start.left + vp.scrollLeft, event.clientY - start.top + vp.scrollTop];
    let active = false;
    const onMove = (move: MouseEvent) => {
      const bounds = vp.getBoundingClientRect();
      const originClient = [origin[0] + bounds.left - vp.scrollLeft, origin[1] + bounds.top - vp.scrollTop];
      if (!active && Math.hypot(move.clientX - originClient[0], move.clientY - originClient[1]) < 4) return;
      active = true;
      move.preventDefault();
      const band = {
        left: Math.min(originClient[0], move.clientX), top: Math.min(originClient[1], move.clientY),
        right: Math.max(originClient[0], move.clientX), bottom: Math.max(originClient[1], move.clientY),
      };
      setMarquee({ left: band.left - bounds.left + vp.scrollLeft, top: band.top - bounds.top + vp.scrollTop, width: band.right - band.left, height: band.bottom - band.top });
      const next = new Set(before);
      for (const cell of vp.querySelectorAll<HTMLElement>("td[data-figure-panel]")) {
        const key = cell.dataset.figurePanel ?? "";
        if (!keys.has(key)) continue;
        const r = cell.getBoundingClientRect();
        if (r.left < band.right && r.right > band.left && r.top < band.bottom && r.bottom > band.top) next.add(key);
      }
      setSelectedPanelKeys(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setMarquee(null);
      if (!active && !onPanel && !additive) setSelectedPanelKeys(new Set());
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const layoutRecipesFor = (targets: readonly FigurePanel[]): LayoutPlotRecipe[] => {
    const recipes: LayoutPlotRecipe[] = [];
    for (const panel of targets) {
      if (panel.plot.type === "heatmap") continue;
      for (const sampleId of panel.samples) {
        const source = prepared.sources.find((entry) => entry.id === sampleId);
        const entry = samples.find((s) => s.id === sampleId);
        if (!source || !entry) continue;
        const resolved = resolveFigurePopulation(panel.population, source.tree, trees);
        const populationId = resolved.id ?? source.tree.root_population_id;
        if (!populationId) continue;
        recipes.push({
          kind: panel.plot.type,
          sampleId,
          populationId,
          xChannel: panel.plot.x,
          yChannel: panel.plot.type === "histogram" ? null : panel.plot.y,
          displayMode: (figure.composition === "overlay" ? "scatter" : config.displayMode) as LayoutDisplayMode,
          // Titled by the sheet's template there; a plot named by the user carries its name for {plot}.
          ...(panel.plot.name && panel.plot.name !== panel.plot.x ? { label: panel.plot.name } : {}),
        });
      }
    }
    return recipes;
  };
  /** The menu a right-click on a panel opens: the panel, its row or its column to the Layout tab; the Gating tab; the figure's data. */
  const openPanelMenu = (panel: FigurePanel, event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    const rowPanels = page ? page.panels.filter((p) => p.row === panel.row) : [panel];
    const columnPanels = page ? page.panels.filter((p) => p.column === panel.column) : [panel];
    const own = layoutRecipesFor([panel]);
    const heatmap = panel.plot.type === "heatmap";
    const items: MenuEntry[] = [
      ...(selectedPanels.length > 1
        ? [{
            label: `Add the ${selectedPanels.length} selected panels to the Layout tab`,
            title: "As arranged here: rows stay rows and columns stay columns, however wide the page",
            disabled: !onAddToLayout,
            onClick: () => addPanelsToLayout(selectedPanels),
          } satisfies MenuEntry]
        : []),
      {
        label: heatmap ? "Add the figure to the Layout tab" : "Add this panel to the Layout tab",
        title: heatmap ? "A heatmap goes to the Layout tab as the whole figure, drawn there as it is here" : "One Layout plot of this file, population and channels",
        disabled: heatmap ? !onAddFigureToLayout : !onAddToLayout || !own.length,
        onClick: () => (heatmap ? onAddFigureToLayout?.(structuredClone(config)) : addPanelsToLayout([panel])),
      },
      { label: "Add this row to the Layout tab", title: "The row's panels side by side, as here", disabled: !onAddToLayout, onClick: () => addPanelsToLayout(rowPanels) },
      { label: "Add this column to the Layout tab", title: "The column's panels one below another, as here", disabled: !onAddToLayout, onClick: () => addPanelsToLayout(columnPanels) },
      "separator",
      {
        label: "Open in Gating",
        title: own.length > 1 ? "A pooled panel has no single file to open" : "This file, population and channels on the Gating tab",
        disabled: !onOpenInGating || own.length !== 1,
        onClick: () => { if (own.length === 1) onOpenInGating?.(own[0]); },
      },
      "separator",
      {
        label: "Remove this population from the figure",
        disabled: figure.populations.length <= 1,
        onClick: () => editFigure({ populations: figure.populations.filter((p) => refKey(p) !== refKey(panel.population)) }),
      },
      {
        label: panel.samples.length > 1 ? "Remove these files from the figure" : "Remove this file from the figure",
        disabled: figure.sampleIds.length <= panel.samples.length,
        onClick: () => editFigure({ sampleIds: figure.sampleIds.filter((id) => !panel.samples.includes(id)) }),
      },
    ];
    setPanelMenu({ x: event.clientX, y: event.clientY, items, label: `${panel.population.label} panel` });
  };
  /**
   * The heatmap matrix's menu: the heatmap goes to the Layout tab on its own or with the whole
   * figure, and its clustering and its place in the figure are switched here.
   */
  const openMatrixMenu = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    const heatmapAlone = (): IllustrationConfig => {
      const copy = structuredClone(config);
      if (copy.figure) copy.figure = { ...copy.figure, plots: copy.figure.plots.filter((p) => p.type === "heatmap") };
      return copy;
    };
    const items: MenuEntry[] = [
      {
        label: "Add the heatmap to the Layout tab",
        title: "One block of the heatmap alone, drawn there as it is here",
        disabled: !onAddFigureToLayout,
        onClick: () => onAddFigureToLayout?.(heatmapAlone()),
      },
      {
        label: "Add the whole figure to the Layout tab",
        title: "One block of every panel and the heatmap, drawn there as it is here",
        disabled: !onAddFigureToLayout,
        onClick: () => onAddFigureToLayout?.(structuredClone(config)),
      },
      "separator",
      {
        label: config.heatmapClusterRows === true ? "Stop clustering rows" : "Cluster rows",
        title: "Average-linkage clustering with a dendrogram; off, rows follow the population order under Arrange",
        onClick: () => style({ heatmapClusterRows: config.heatmapClusterRows !== true }),
      },
      {
        label: config.heatmapClusterColumns === true ? "Stop clustering channels" : "Cluster channels",
        title: "Average-linkage clustering with a dendrogram; off, channels follow the plot order under Plots",
        onClick: () => style({ heatmapClusterColumns: config.heatmapClusterColumns !== true }),
      },
      "separator",
      {
        label: "Remove the heatmap from the figure",
        title: "The figure keeps its other plots",
        disabled: figure.plots.every((p) => p.type === "heatmap"),
        onClick: () => editFigure({ plots: figure.plots.filter((p) => p.type !== "heatmap") }),
      },
    ];
    setPanelMenu({ x: event.clientX, y: event.clientY, items, label: "Heatmap" });
  };
  const problems = Object.values(built.data).filter((p) => p.problem),
    validPanels = Object.values(built.data).filter((p) => p.config).length;
  const populationOptions = figurePopulationOptions(trees);
  // Tree depth per option, so the list indents like the population tree. Keyed by the
  // canonical reference, as the options are.
  const populationDepths = useMemo(() => {
    const out = new Map<string, number>();
    for (const tree of Object.values(trees))
      for (const { popId, depth } of populationTreeOrder(tree.populations, tree.root_population_id ?? "")) {
        const key = refKey(canonicalPopulation({ hierarchyId: tree.id, populationId: popId, label: "" }, trees));
        if (!out.has(key)) out.set(key, depth);
      }
    return out;
  }, [trees]);
  // The metadata chips, as in the file list, over the figure's own selection.
  const figureFacets = useMemo(() => {
    const metadata = Object.fromEntries(samples.filter((s) => s.metadata).map((s) => [s.id, s.metadata!]));
    const columns = [...new Set(Object.values(metadata).flatMap((m) => Object.keys(m)))].map((name) => ({ name }));
    return facetColumns(metadata, columns);
  }, [samples]);
  const figureExcluded = useMemo(() => new Set(samples.filter((s) => !figure.sampleIds.includes(s.id)).map((s) => s.id)), [samples, figure.sampleIds]);
  const figureChannels = useMemo(() => [...new Set(figure.plots.flatMap((plot) => (plot.type === "histogram" ? [plot.x] : [plot.x, plot.y])).filter(Boolean))], [figure.plots]);
  const selectedSamples = figure.sampleIds
    .map((id) => samples.find((s) => s.id === id))
    .filter((s): s is FigureSample => !!s);
  /** Whether any file needs a say in which of its populations a figure population is. */
  const mappingNeedsAttention = useMemo(
    () => selectedSamples.some((s) => figure.populations.some((p) =>
      !!figure.populationOverrides?.[s.id]?.[refKey(p)]
      || !trees[s.hierarchyId]
      || resolveFigurePopulation(p, trees[s.hierarchyId], trees).status !== "matched")),
    [selectedSamples, figure.populations, figure.populationOverrides, trees],
  );
  /** A population with nothing beneath it in its tree. */
  const isLeafPopulation = (ref: FigurePopulation) => {
    const tree = trees[ref.hierarchyId];
    return !!tree && !(tree.populations[ref.populationId]?.children ?? []).some((id) => tree.populations[id]);
  };
  const applicableFiles = (ref: FigurePopulation) =>
    selectedSamples.filter((s) =>
      figurePopulationApplies(ref, s, trees, figure),
    );
  const unassignedSelections = figure.populations.filter(
    (ref) => !applicableFiles(ref).length,
  );
  /** The populations the list shows: those a selected file has, and any already in the figure. */
  const listedPopulationOptions = populationOptions.filter(
    (ref) => applicableFiles(ref).length || figure.populations.some((p) => refKey(p) === refKey(ref)),
  );
  /** The Gating tab's ticked populations, as figure references, where the list has them. */
  const checkedPopulationOptions = state.selected_pop_ids
    .map((popId) => refKey(canonicalPopulation({ hierarchyId: state.active_hierarchy_id, populationId: popId, label: "" }, trees)))
    .flatMap((key) => listedPopulationOptions.filter((ref) => refKey(ref) === key));
  const channels = [
    ...new Map(
      selectedSamples.flatMap((s) =>
        s.sample.channels.map(
          (c) => [c.key, s.sample.labelForKey(c.key)] as const,
        ),
      ),
    ).entries(),
  ];
  const desiredWidth =
    (page?.columns.length ?? 1) * (figure.panelSize + 16) +
    (page?.rows[0]?.length ?? 0) * 115 +
    40;
  const scale =
    zoom === "fit"
      ? Math.min(
          1,
          Math.max(0.5, (previewWidth - 28) / (paperWidth || desiredWidth)),
        )
      : Number(zoom);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  // Option-scroll, Shift-scroll or a trackpad pinch (Ctrl-wheel) zooms the figure about the
  // pointer; the select then shows the value it landed on. A DOM listener, since React's wheel
  // listeners are passive and cannot cancel the scroll.
  useEffect(() => {
    const scroller = viewport.current;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.altKey || event.shiftKey || event.ctrlKey)) return;
      const delta = event.deltaY || event.deltaX;
      if (!delta) return;
      event.preventDefault();
      const current = scaleRef.current;
      const next = Math.max(0.25, Math.min(4, Math.round(current * Math.exp(-delta * 0.0025) * 100) / 100));
      if (next === current) return;
      scaleRef.current = next;
      setZoom(String(next));
      const rect = scroller.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const ratio = next / current;
      const left = (scroller.scrollLeft + px) * ratio - px;
      const top = (scroller.scrollTop + py) * ratio - py;
      requestAnimationFrame(() => {
        scroller.scrollLeft = left;
        scroller.scrollTop = top;
      });
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, []);
  const metadataFields = [
    ...new Set(samples.flatMap((s) => Object.keys(s.metadata ?? {}))),
  ];
  /** The population table's fields that any of the figure's populations has a value in. */
  const populationMetadataFields = [
    ...new Set(figure.populations.flatMap((p) => Object.keys(populationMetadata?.[p.populationId] ?? {}))),
  ].filter((field) => figure.populations.some((p) => (populationMetadata?.[p.populationId]?.[field] ?? "").trim()));
  const placedDimensions: FigureDimension[] = [...figure.rows, ...figure.columns, ...figure.pages];
  function place(
    dimension: FigureDimension,
    location: "rows" | "columns" | "pages",
  ) {
    const patch = {
      rows: figure.rows.filter((d) => d !== dimension),
      columns: figure.columns.filter((d) => d !== dimension),
      pages: figure.pages.filter((d) => d !== dimension),
    };
    patch[location].push(dimension);
    editFigure(patch);
  }
  async function exportPage() {
    if (!page || pending || problems.length || exporting) return;
    setExporting(true);
    setExportError("");
    const snapshot = structuredClone(config),
      spec = snapshot.figure!;
    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;left:-100000px;top:0;background:white;width:max-content;pointer-events:none;";
    host.className = "gl-figure-export";
    document.body.appendChild(host);
    try {
      const data: typeof built.data = {};
      for (const panel of page.panels) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!alive.current) return;
        data[panel.key] = buildFigurePanel(
          panel,
          { ...spec, showGates: true },
          built.projected,
          trees,
          figureStyle(snapshot, exportAll),
          built.ranges,
          exportAll,
        );
        if (data[panel.key].problem) throw new Error(data[panel.key].problem);
      }
      const id = `figure-export-${crypto.randomUUID()}`;
      const coloured = colourFigureSummaries(page, data, snapshot);
      host.innerHTML = renderToStaticMarkup(
        <FigureGrid
          id={id}
          page={page}
          panels={coloured}
          config={snapshot}
          size={spec.panelSize}
          showGates={spec.showGates}
        />,
      );
      const cells = [
        ...host.querySelectorAll<HTMLElement>("[data-figure-panel]"),
      ];
      page.panels.forEach((panel) => {
        const node = cells
          .find((cell) => cell.dataset.figurePanel === panel.key)
          ?.querySelector<HTMLElement>(".mini-plot-cell");
        if (node && coloured[panel.key].config)
          drawFigurePlot(
            node,
            styledFigurePlot(
              coloured[panel.key].config!,
              snapshot,
              panel.plot.type === "heatmap"
                ? Math.max(50, snapshot.heatmapCellSize ?? 80)
                : spec.panelSize,
              spec.showGates,
            ),
          );
      });
      const filename = `${sanitizeFilePart(spec.name)}-${currentPage + 1}`;
      if (exportFormat === "svg") exportGridSVG(id, filename, exportDpi);
      else if (exportFormat === "png")
        await exportGridPNG(id, filename, exportDpi);
      else await exportGridPDF(id, filename, exportDpi);
    } catch (error) {
      if (alive.current)
        setExportError(error instanceof Error ? error.message : String(error));
    } finally {
      host.remove();
      if (alive.current) setExporting(false);
    }
  }
  return (
    <div className="gl-figure-workspace">
      <header className="gl-figure-toolbar">
        <input
          aria-label="Figure name"
          value={figure.name}
          disabled={exporting}
          onChange={(e) => editFigure({ name: e.target.value })}
        />
        <span className="gl-figure-subtle">Stored in workspace</span>
        <button
          disabled={!history.length || exporting}
          onClick={() => {
            setFuture((f) => [config, ...f]);
            setConfig(history.at(-1)!);
            setHistory((h) => h.slice(0, -1));
          }}
        >
          Undo
        </button>
        <button
          disabled={!future.length || exporting}
          onClick={() => {
            setHistory((h) => [...h, config]);
            setConfig(future[0]);
            setFuture((f) => f.slice(1));
          }}
        >
          Redo
        </button>
        <span className="gl-figure-flex" />
        <button onClick={onOpenGating}>Edit gates</button>
        <button onClick={() => setSection("export")}>Export…</button>
      </header>
      <div className="gl-figure-body">
        <aside className="gl-figure-inspector" aria-label="Figure inspector" style={{ width: inspectorWidth, flex: `0 0 ${inspectorWidth}px` }}>
          <nav role="tablist" aria-label="Figure settings">
            {["data", "plots", "arrange", "style", "export"].map((id) => (
              <button
                key={id}
                role="tab"
                tabIndex={section === id ? 0 : -1}
                onKeyDown={(event) => {
                  const ids = ["data", "plots", "arrange", "style", "export"];
                  const offset =
                    event.key === "ArrowRight"
                      ? 1
                      : event.key === "ArrowLeft"
                        ? -1
                        : 0;
                  if (offset) {
                    event.preventDefault();
                    const next =
                      ids[(ids.indexOf(id) + offset + ids.length) % ids.length];
                    setSection(next);
                    document.getElementById(`figure-tab-${next}`)?.focus();
                  }
                }}
                id={`figure-tab-${id}`}
                aria-controls={`figure-section-${id}`}
                aria-selected={section === id}
                onClick={() => setSection(id)}
              >
                {
                  {
                    data: "Data",
                    plots: "Plots",
                    arrange: "Arrange",
                    style: "Style",
                    export: "Export",
                  }[id]
                }
              </button>
            ))}
          </nav>
          <fieldset disabled={exporting} className="gl-figure-fields">
            <section
              hidden={section !== "data"}
              id="figure-section-data"
              role="tabpanel"
              aria-labelledby="figure-tab-data"
            >
              <h3 title="Each entry is an FCS file, not necessarily one biological sample. The figure's selection is independent of the Gating tab's.">
                Files / samples <span>{figure.sampleIds.length} selected</span>
              </h3>
              <div className="gl-figure-actions gl-figure-list-actions">
                <button
                  onClick={() =>
                    editFigure({ sampleIds: [...checkedSampleIds] })
                  }
                >
                  Use checked files
                </button>
                <button
                  onClick={() =>
                    editFigure({ sampleIds: samples.map((s) => s.id) })
                  }
                >
                  All
                </button>
                <button onClick={() => editFigure({ sampleIds: [] })}>
                  None
                </button>
              </div>
              <input
                type="search"
                aria-label="Find figure files or samples"
                placeholder="Find file / sample…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="gl-figure-list">
                {samples
                  .filter((s) =>
                    `${s.name} ${s.fileName ?? ""}`.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((s) => (
                    <label key={s.id} className="gl-figure-row" title={s.fileName && s.fileName !== s.name ? `${s.name} · ${s.fileName}` : s.name}>
                      <input
                        type="checkbox"
                        checked={figure.sampleIds.includes(s.id)}
                        onChange={() =>
                          editFigure({
                            sampleIds: figure.sampleIds.includes(s.id)
                              ? figure.sampleIds.filter((id) => id !== s.id)
                              : [...figure.sampleIds, s.id],
                          })
                        }
                      />
                      <span className="gl-figure-row-name">{s.name}{s.fileName && s.fileName !== s.name && <small>{s.fileName}</small>}</span>
                    </label>
                  ))}
              </div>
              {figureFacets.length > 0 && (
                <details className="gl-figure-facets-fold" open>
                  <summary>Select by metadata</summary>
                <div className="gl-sample-facets gl-figure-facets" aria-label="Select figure files by metadata">
                  {figureFacets.map((column) => (
                    <div key={column.name} className="gl-sample-facet-row">
                      <span className="gl-sample-facet-lock" aria-hidden="true" />
                      <span className="gl-sample-facet-name" title={column.name}>{column.name}</span>
                      <div className="gl-sample-facet-values">
                        {column.values.map((entry) => {
                          const on = groupCheckedCount(entry.sampleIds, figureExcluded);
                          const total = entry.sampleIds.length;
                          const chipState = on === total ? "all" : on === 0 ? "none" : "some";
                          const fill = total > 0 ? Math.round((on / total) * 100) : 0;
                          return (
                            <button
                              key={entry.value}
                              type="button"
                              className={`gl-sample-facet-chip is-${chipState}`}
                              style={chipState === "some" ? { "--gl-facet-fill": `${fill}%` } as CSSProperties : undefined}
                              aria-pressed={on === total}
                              title={`${entry.value}: ${on} of ${total} selected — ${on === total ? `click to deselect all ${total}` : `click to select all ${total}`}`}
                              onClick={() => {
                                const excluded = toggleGroupChecked(entry.sampleIds, figureExcluded);
                                editFigure({ sampleIds: samples.filter((s) => !excluded.has(s.id)).map((s) => s.id) });
                              }}
                            >
                              <span className="gl-sample-facet-label">{entry.value}</span>
                              <span className="gl-sample-facet-count">{on}/{total}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                </details>
              )}
              {figure.sampleIds.some(
                (id) => !samples.some((s) => s.id === id),
              ) && (
                <p role="alert">
                  A saved file is missing. Restore it or use the current checked
                  files.
                </p>
              )}
              <h3 title="A population applies to the files whose tree has it. Correspondence is by provenance, not by name.">
                Populations <span>{figure.populations.length} selected</span>
              </h3>
              <div className="gl-figure-actions gl-figure-list-actions">
                <button
                  disabled={!checkedPopulationOptions.length}
                  title="The populations ticked on the Gating tab"
                  onClick={() => editFigure({ populations: checkedPopulationOptions })}
                >
                  Use checked populations
                </button>
                <button onClick={() => editFigure({ populations: listedPopulationOptions })}>All</button>
                <button onClick={() => editFigure({ populations: [] })}>None</button>
                <button
                  title="The populations with nothing beneath them"
                  onClick={() => editFigure({ populations: listedPopulationOptions.filter(isLeafPopulation) })}
                >
                  Leaves
                </button>
              </div>
              <input
                type="search"
                aria-label="Find figure populations"
                placeholder="Find population…"
                value={populationSearch}
                onChange={(e) => setPopulationSearch(e.target.value)}
              />
              <div className="gl-figure-list gl-figure-list-populations">
                {listedPopulationOptions
                  .filter((ref) => `${ref.label} ${trees[ref.hierarchyId]?.name ?? ""}`.toLowerCase().includes(populationSearch.toLowerCase()))
                  .map((ref) => (
                    <label
                      key={refKey(ref)}
                      className="gl-figure-row"
                      style={{ paddingLeft: 6 + 12 * (populationDepths.get(refKey(ref)) ?? 0) }}
                      title={ref.label}
                    >
                      <input
                        type="checkbox"
                        checked={figure.populations.some(
                          (p) => refKey(p) === refKey(ref),
                        )}
                        onChange={() =>
                          editFigure({
                            populations: figure.populations.some(
                              (p) => refKey(p) === refKey(ref),
                            )
                              ? figure.populations.filter(
                                  (p) => refKey(p) !== refKey(ref),
                                )
                              : [...figure.populations, ref],
                          })
                        }
                      />
                      <span className="gl-figure-row-name">{ref.label}</span>
                      {Object.keys(trees).length > 1 && (
                        <small className="gl-figure-row-meta">{trees[ref.hierarchyId]?.name}</small>
                      )}
                      {applicableFiles(ref).length < selectedSamples.length && (
                        <small
                          className="gl-figure-row-meta"
                          title={`${applicableFiles(ref).length} of ${selectedSamples.length} selected files have this population`}
                        >
                          {applicableFiles(ref).length}/{selectedSamples.length}
                        </small>
                      )}
                    </label>
                  ))}
              </div>
              {unassignedSelections.length > 0 && (
                <div className="gl-figure-note" role="status">
                  {unassignedSelections
                    .map(
                      (ref) => `${ref.label} (${trees[ref.hierarchyId]?.name})`,
                    )
                    .join(", ")}
                  : no selected files use this hierarchy. No panels are added
                  for these selections.
                  <button
                    onClick={() =>
                      editFigure({
                        populations: figure.populations.filter(
                          (ref) => !unassignedSelections.includes(ref),
                        ),
                      })
                    }
                  >
                    Remove unused selections
                  </button>
                </div>
              )}
              {figure.populations
                .filter(
                  (ref) =>
                    !populationOptions.some((p) => refKey(p) === refKey(ref)),
                )
                .map((ref) => (
                  <div key={refKey(ref)} className="gl-figure-warning">
                    {ref.label}
                    <button
                      onClick={() =>
                        editFigure({
                          populations: figure.populations.filter(
                            (p) => p !== ref,
                          ),
                        })
                      }
                    >
                      Remove unavailable selection
                    </button>
                  </div>
                ))}
              {figure.samplePopulations && (
                <div className="gl-figure-warning">
                  This saved figure has per-file population selections.
                  <button
                    onClick={() => editFigure({ samplePopulations: undefined })}
                  >
                    Use selected populations for every file
                  </button>
                </div>
              )}
              {/* Under one tree per workspace every population matches by provenance; the mapping
                  controls only appear when something does not, or an explicit choice was made. */}
              {mappingNeedsAttention ? (
              <details open>
                <summary>Hierarchy mapping</summary>
                <p>
                  Automatic correspondence uses provenance, not names. An
                  explicit choice below acknowledges a different population
                  definition.
                </p>
                {selectedSamples.map((s) => (
                  <div key={s.id} className="gl-figure-mapping">
                    <strong>{s.name}</strong>
                    <small>
                      {trees[s.hierarchyId]?.name ?? "Missing hierarchy"}
                    </small>
                    {figure.populations.map((p) => (
                      <label key={refKey(p)}>
                        {p.label}:{" "}
                        {figure.populationOverrides?.[s.id]?.[refKey(p)]
                          ? "explicit mapping"
                          : trees[s.hierarchyId]
                            ? resolveFigurePopulation(
                                p,
                                trees[s.hierarchyId],
                                trees,
                              ).status
                            : "missing"}
                        <select
                          aria-label={`Map ${p.label} in ${s.name}`}
                          value={
                            figure.populationOverrides?.[s.id]?.[refKey(p)] ??
                            ""
                          }
                          onChange={(e) =>
                            editFigure({
                              populationOverrides: {
                                ...figure.populationOverrides,
                                [s.id]: {
                                  ...figure.populationOverrides?.[s.id],
                                  [refKey(p)]: e.target.value,
                                },
                              },
                            })
                          }
                        >
                          <option value="">Automatic provenance mapping</option>
                          {Object.values(
                            trees[s.hierarchyId]?.populations ?? {},
                          ).map((pop) => (
                            <option
                              key={pop.population_id}
                              value={pop.population_id}
                            >
                              {pop.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                ))}
              </details>
              ) : null}
              <details>
                <summary>Saved figures & presets</summary>
                <label>
                  Preset
                  <select
                    value={preset}
                    onChange={(e) => setPreset(e.target.value)}
                  >
                    <option value="">Choose…</option>
                    {presets.map((p) => (
                      <option key={p.name}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <div className="gl-figure-actions">
                  <button
                    disabled={!preset}
                    onClick={() => {
                      const p = presets.find((p) => p.name === preset);
                      if (p)
                        change({
                          ...p.config,
                          figure: migrateFigure(
                            p.config,
                            samples,
                            trees,
                            state.active_hierarchy_id,
                            defaultX,
                            defaultY,
                          ),
                        });
                    }}
                  >
                    Load
                  </button>
                  <button
                    disabled={!preset}
                    onClick={() => {
                      onDeletePreset(preset);
                      setPreset("");
                    }}
                  >
                    Delete preset
                  </button>
                </div>
                <label>
                  Save as
                  <input
                    value={presetName}
                    onChange={(e) => setPresetName(e.target.value)}
                  />
                </label>
                <button
                  disabled={!presetName.trim()}
                  onClick={() => {
                    configRef.current = config;
                    onSavePreset(presetName.trim());
                    setPresetName("");
                  }}
                >
                  Save figure preset
                </button>
              </details>
            </section>
            <section
              hidden={section !== "plots"}
              id="figure-section-plots"
              role="tabpanel"
              aria-labelledby="figure-tab-plots"
            >
              <h3 title="Each plot has its own axes; the plots repeat across the selected files and populations.">Plot definitions</h3>
              {figure.plots.map((plot, index) => (
                <div className="gl-figure-plot-editor" key={plot.id}>
                  <label>
                    Name
                    <input
                      value={plot.name}
                      onChange={(e) =>
                        editFigure({
                          plots: figure.plots.map((p) =>
                            p.id === plot.id
                              ? { ...p, name: e.target.value }
                              : p,
                          ),
                        })
                      }
                    />
                  </label>
                  <label>
                    Type
                    <select
                      value={plot.type}
                      onChange={(e) =>
                        editFigure({
                          plots: figure.plots.map((p) =>
                            p.id === plot.id
                              ? {
                                  ...p,
                                  type: e.target.value as typeof plot.type,
                                }
                              : p,
                          ),
                        })
                      }
                    >
                      <option value="biplot">Biplot</option>
                      <option value="histogram">Histogram</option>
                      <option value="heatmap">Summary heatmap</option>
                    </select>
                  </label>
                  {(["x", "y"] as const)
                    .filter((axis) => axis === "x" || plot.type === "biplot")
                    .map((axis) => (
                      <label key={axis}>
                        {axis.toUpperCase()} channel
                        <SearchableSelect
                          label={`${axis.toUpperCase()} channel`}
                          className="gl-searchable-select-field"
                          value={plot[axis]}
                          options={[
                            ...(channels.some(([key]) => key === plot[axis]) ? [] : [{ value: plot[axis], label: "Unavailable channel" }]),
                            ...channels.map(([key, label]) => ({ value: key, label })),
                          ]}
                          onChange={(value) =>
                            editFigure({
                              plots: figure.plots.map((p) =>
                                p.id === plot.id ? { ...p, [axis]: value } : p,
                              ),
                            })
                          }
                        />
                      </label>
                    ))}
                  <label>
                    Population
                    <select
                      value={plot.population ? refKey(plot.population) : ""}
                      onChange={(e) =>
                        editFigure({
                          plots: figure.plots.map((p) =>
                            p.id === plot.id
                              ? {
                                  ...p,
                                  population: populationOptions.find(
                                    (ref) => refKey(ref) === e.target.value,
                                  ),
                                }
                              : p,
                          ),
                        })
                      }
                    >
                      <option value="">Repeat selected populations</option>
                      {populationOptions.map((ref) => (
                        <option key={refKey(ref)} value={refKey(ref)}>
                          {ref.label} · {trees[ref.hierarchyId]?.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="gl-figure-actions">
                    <button
                      disabled={index === 0}
                      aria-label={`Move ${plot.name} up`}
                      onClick={() =>
                        editFigure({ plots: move(figure.plots, index, -1) })
                      }
                    >
                      Up
                    </button>
                    <button
                      disabled={index === figure.plots.length - 1}
                      aria-label={`Move ${plot.name} down`}
                      onClick={() =>
                        editFigure({ plots: move(figure.plots, index, 1) })
                      }
                    >
                      Down
                    </button>
                    <button
                      onClick={() =>
                        editFigure({
                          plots: figure.plots.filter((p) => p.id !== plot.id),
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              <button
                onClick={() =>
                  editFigure({
                    plots: [
                      ...figure.plots,
                      {
                        id: crypto.randomUUID(),
                        name: `Plot ${figure.plots.length + 1}`,
                        x: channels[0]?.[0] ?? defaultX,
                        y: channels[1]?.[0] ?? defaultY,
                        type: "biplot",
                      },
                    ],
                  })
                }
              >
                Add plot
              </button>
            </section>
            <section
              hidden={section !== "arrange"}
              id="figure-section-arrange"
              role="tabpanel"
              aria-labelledby="figure-tab-arrange"
            >
              <h3 title="Drag between shelves, or use the placement menus. Earlier dimensions form outer groups.">Arrange dimensions</h3>
              <label>
                <input
                  type="checkbox"
                  checked={!!figure.overlayPopulations}
                  onChange={(e) =>
                    editFigure({ overlayPopulations: e.target.checked })
                  }
                />
                Overlay populations within each panel
              </label>
              <p>
                Overlaid populations can overlap. Their membership counts are
                not a unique event total.
              </p>
              {(["rows", "columns", "pages"] as const).map((location) => (
                <div
                  key={location}
                  className="gl-figure-shelf"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const d = e.dataTransfer.getData(
                      "text/gatelab-dimension",
                    ) as FigureDimension;
                    if (
                      [
                        ...figure.rows,
                        ...figure.columns,
                        ...figure.pages,
                      ].includes(d)
                    )
                      place(d, location);
                  }}
                >
                  <h4>{location}</h4>
                  {figure[location].map((d, i) => (
                    <div
                      className="gl-figure-dimension"
                      key={d}
                      draggable
                      onDragStart={(e) =>
                        e.dataTransfer.setData("text/gatelab-dimension", d)
                      }
                    >
                      <span>{dimensionLabel(d)}</span>
                      <select
                        aria-label={`Place ${d}`}
                        value={location}
                        onChange={(e) =>
                          place(d, e.target.value as typeof location)
                        }
                      >
                        <option value="rows">Rows</option>
                        <option value="columns">Columns</option>
                        <option value="pages">Pages</option>
                      </select>
                      <button
                        aria-label={`Move ${d} earlier`}
                        disabled={i === 0}
                        onClick={() =>
                          editFigure({
                            [location]: move(figure[location], i, -1),
                          })
                        }
                      >
                        ↑
                      </button>
                      {(d.startsWith("metadata:") || d.startsWith("popmeta:")) && (
                        <button
                          aria-label={`Remove ${d}`}
                          onClick={() =>
                            editFigure({
                              [location]: figure[location].filter(
                                (x) => x !== d,
                              ),
                            })
                          }
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ))}
              <label>
                Add metadata grouping
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) place(e.target.value as FigureDimension, "pages");
                  }}
                >
                  <option value="">Choose field…</option>
                  <optgroup label="Files / samples">
                    {metadataFields
                      .filter((field) => !placedDimensions.includes(`metadata:${field}`))
                      .map((field) => (
                        <option key={field} value={`metadata:${field}`}>{field}</option>
                      ))}
                  </optgroup>
                  <optgroup label="Populations">
                    {populationMetadataFields
                      .filter((field) => !placedDimensions.includes(`popmeta:${field}`))
                      .map((field) => (
                        <option key={field} value={`popmeta:${field}`}>{field}</option>
                      ))}
                  </optgroup>
                </select>
              </label>
              <h3 title="Click to choose rows (Cmd or Ctrl adds, Shift takes a range), drag them to where they should go, or sort them all at once.">Order populations</h3>
              <OrderList
                label="Population order"
                items={figure.populations}
                keyOf={refKey}
                labelOf={(p) => p.label}
                onReorder={(populations) => editFigure({ populations })}
                sorts={[
                  {
                    label: "Tree order",
                    title: "As they stand in the population tree",
                    apply: (items) => [...items].sort((a, b) => populationOptions.findIndex((o) => refKey(o) === refKey(a)) - populationOptions.findIndex((o) => refKey(o) === refKey(b))),
                  },
                  { label: "A→Z", title: "By name", apply: (items) => [...items].sort((a, b) => a.label.localeCompare(b.label)) },
                ]}
              />
              <h3 title="Click to choose rows (Cmd or Ctrl adds, Shift takes a range), drag them to where they should go, or sort them all at once.">Order files / samples</h3>
              <OrderList
                label="File order"
                items={selectedSamples}
                keyOf={(s) => s.id}
                labelOf={(s) => s.name}
                onReorder={(ordered) => editFigure({ sampleIds: ordered.map((s) => s.id) })}
                sorts={[
                  { label: "File list order", title: "As the files are listed on the Gating tab", apply: (items) => samples.filter((s) => items.some((item) => item.id === s.id)) },
                  { label: "A→Z", title: "By name", apply: (items) => [...items].sort((a, b) => a.name.localeCompare(b.name)) },
                ]}
              />
            </section>
            <section
              hidden={section !== "style"}
              id="figure-section-style"
              role="tabpanel"
              aria-labelledby="figure-tab-style"
            >
              <h3>Axes & rendering</h3>
              <label>
                Axis ranges
                <select
                  value={figure.scalePolicy}
                  disabled={figure.composition !== "separate"}
                  onChange={(e) =>
                    editFigure({
                      scalePolicy: e.target.value as FigureSpec["scalePolicy"],
                      scalePolicyChosen: true,
                    })
                  }
                >
                  <option value="shared">Shared by channel</option>
                  <option value="individual">Fit each file</option>
                  <option value="gating">As on the Gating tab</option>
                </select>
              </label>
              {onFitChannels && (
                <div className="gl-figure-actions">
                  <button
                    type="button"
                    disabled={figure.composition !== "separate" || !figureChannels.length}
                    title="Fit every channel this figure plots to its data and the gates on it, on the Gating tab's own range map, and show the figure on those ranges"
                    onClick={() => { onFitChannels(figureChannels); editFigure({ scalePolicy: "gating", scalePolicyChosen: true }); }}
                  >
                    Fit data + gates
                  </button>
                </div>
              )}
              {figure.scalePolicy === "gating" ? (
                <p>Axes follow the Gating tab: its transforms and its ranges, as they are now.</p>
              ) : (
                <>
                  <p>
                    Transforms belong to this figure; shared ranges span all selected files.
                    Choose “As on the Gating tab” to match the Gating tab's axes.
                  </p>
                  <button onClick={() => editFigure({ transforms: {} })}>
                    Capture current channel transforms
                  </button>
                </>
              )}
              {figure.plots.some((p) => p.type === "heatmap") && (
                <details open>
                  <summary>Summary heatmap</summary>
                  <label>
                    Statistic
                    <select
                      value={config.heatmapStat ?? "median"}
                      onChange={(e) =>
                        style({
                          heatmapStat: e.target.value as "median" | "mean",
                        })
                      }
                    >
                      <option value="median">Median</option>
                      <option value="mean">Mean</option>
                    </select>
                  </label>
                  <label>
                    Colour scale
                    <select
                      value={config.heatmapScale ?? "column_quantile"}
                      onChange={(e) =>
                        style({
                          heatmapScale: e.target
                            .value as IllustrationConfig["heatmapScale"],
                        })
                      }
                    >
                      <option value="column_quantile">
                        Per channel: 1st to 99th percentile of the events
                      </option>
                      <option value="column_minmax">
                        Per channel: minimum–maximum of the summaries
                      </option>
                      <option value="row_minmax">
                        Per row: minimum–maximum
                      </option>
                      <option value="column_zscore">Per channel: z-score</option>
                      <option value="none">Unscaled transformed expression</option>
                    </select>
                  </label>
                  <label>
                    Cell size
                    <NumberField
                      min={12}
                      max={120}
                      integer
                      value={config.heatmapCellSize ?? 28}
                      onCommit={(heatmapCellSize) => style({ heatmapCellSize })}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={config.heatmapClusterRows === true}
                      onChange={(e) => style({ heatmapClusterRows: e.target.checked })}
                    />
                    Cluster rows (average linkage, with dendrogram); off, rows follow the population order under Arrange
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={config.heatmapClusterColumns === true}
                      onChange={(e) => style({ heatmapClusterColumns: e.target.checked })}
                    />
                    Cluster channels; off, they follow the plot order under Plots
                  </label>
                  <label>
                    Beside the rows
                    <select
                      value={config.heatmapBars ?? "counts"}
                      onChange={(e) => style({ heatmapBars: e.target.value as IllustrationConfig["heatmapBars"] })}
                    >
                      <option value="counts">Event counts as bars</option>
                      <option value="none">Nothing</option>
                    </select>
                  </label>
                  <p>
                    One matrix per page: a row per population and file, a column per
                    heatmap plot. Statistics use all finite events; the percentile
                    scaling pools the events of every row, so a channel's colours
                    compare across the page. Numbers show the unscaled statistic.
                  </p>
                </details>
              )}
              <label>
                Display
                <select
                  value={
                    figure.composition === "overlay"
                      ? "scatter"
                      : config.displayMode
                  }
                  disabled={figure.composition === "overlay"}
                  onChange={(e) => style({ displayMode: e.target.value })}
                >
                  <option value="pseudocolor">Pseudocolour</option>
                  <option value="scatter">Scatter</option>
                  <option value="contour">Contour</option>
                </select>
              </label>
              {figure.plots.some((p) => p.type === "heatmap") && (
                <>
                  <label>
                    Heatmap palette
                    <select
                      value={config.heatmapPalette ?? "rdylbu"}
                      onChange={(e) =>
                        style({
                          heatmapPalette: e.target
                            .value as IllustrationConfig["heatmapPalette"],
                        })
                      }
                    >
                      <option value="rdylbu">Red–yellow–blue (RdYlBu)</option>
                      <option value="blue_white_yellow_red">
                        Blue–white–yellow–red
                      </option>
                      <option value="viridis">Viridis</option>
                      <option value="heat">Heat</option>
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={config.heatmapShowValues !== false}
                      onChange={(e) =>
                        style({ heatmapShowValues: e.target.checked })
                      }
                    />
                    Show summary values
                  </label>
                </>
              )}
              {figure.plots.some((p) => p.type === "histogram") && (
                <>
                  <label>
                    Histogram arrangement
                    <select
                      value={config.histLayout}
                      onChange={(e) => style({ histLayout: e.target.value })}
                    >
                      <option value="grid">Density plot</option>
                      <option value="ridgeline">Stacked ridgelines</option>
                    </select>
                  </label>
                  {config.histLayout === "ridgeline" && (
                    <>
                      <p>
                        Overlay files or populations to stack their
                        distributions within a panel. Each ridge is
                        peak-normalised.
                      </p>
                      <label>
                        Ridge overlap
                        <input
                          type="range"
                          min={0}
                          max={0.95}
                          step={0.05}
                          value={config.ridgeOverlap}
                          onChange={(e) =>
                            style({ ridgeOverlap: Number(e.target.value) })
                          }
                        />
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={config.ridgeGradient}
                          onChange={(e) =>
                            style({ ridgeGradient: e.target.checked })
                          }
                        />
                        Intensity gradient
                      </label>
                    </>
                  )}
                </>
              )}
              <label>
                Preview events per panel
                <NumberField
                  min={100}
                  max={1000000}
                  step={1000}
                  integer
                  value={config.maxEvents}
                  onCommit={(maxEvents) => style({ maxEvents })}
                />
              </label>
              <p>
                Preview has a 1,000,000-point page budget, shared by the panels on the page.
                Counts use every event. Export can draw all events.
              </p>
              <label>
                Point size
                <NumberField
                  min={0.25}
                  max={5}
                  step={0.25}
                  value={config.pointSize}
                  onCommit={(pointSize) => style({ pointSize })}
                />
              </label>
              <label>
                Opacity {config.pointAlpha}
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={config.pointAlpha}
                  onChange={(e) =>
                    style({ pointAlpha: Number(e.target.value) })
                  }
                />
              </label>
              {config.displayMode === "pseudocolor" &&
                figure.composition !== "overlay" && (
                  <label>
                    Density contrast
                    <input
                      type="range"
                      min={0.5}
                      max={3}
                      step={0.1}
                      value={config.densityColorPower}
                      onChange={(e) =>
                        style({ densityColorPower: Number(e.target.value) })
                      }
                    />
                  </label>
                )}
              {config.displayMode === "contour" && (
                <>
                  <label>
                    Contour %
                    <NumberField
                      min={0}
                      max={50}
                      value={config.contourThreshold}
                      onCommit={(contourThreshold) => style({ contourThreshold })}
                    />
                  </label>
                  <label>
                    Smoothing (0 = automatic)
                    <NumberField
                      min={0}
                      max={14}
                      step={0.2}
                      value={config.kdeBandwidth}
                      onCommit={(kdeBandwidth) => style({ kdeBandwidth })}
                    />
                  </label>
                  <label>Number of contours<NumberField min={2} max={30} integer value={config.contourLevels ?? 10} onCommit={(contourLevels) => style({ contourLevels })} /></label>
                </>
              )}
              {figure.plots.some((p) => p.type === "histogram") && (
                <details>
                  <summary>Histogram style</summary>
                  <label>
                    <input
                      type="checkbox"
                      checked={config.histFill}
                      onChange={(e) => style({ histFill: e.target.checked })}
                    />
                    Fill density
                  </label>
                  <label>
                    Line width
                    <NumberField
                      min={0.5}
                      max={5}
                      step={0.25}
                      value={config.histLineWidth}
                      onCommit={(histLineWidth) => style({ histLineWidth })}
                    />
                  </label>
                  <p>Histograms show density, not absolute event counts.</p>
                </details>
              )}
              <h3>Gates</h3>
              <label>
                <input
                  type="checkbox"
                  checked={figure.showGates}
                  onChange={(e) => editFigure({ showGates: e.target.checked })}
                />
                Show each file’s gates
              </label>
              <p>
                Mixed-file panels omit gate outlines. Percentages in single-file
                panels are relative to the displayed population.
              </p>
              <label>
                Edges
                <select
                  value={config.gateEdgeMode}
                  onChange={(e) =>
                    style({ gateEdgeMode: e.target.value as GateEdgeMode })
                  }
                >
                  {GATE_EDGE_MODES.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={config.pubStyle}
                  onChange={(e) => style({ pubStyle: e.target.checked })}
                />
                Plain gate labels
              </label>
              <label>
                Line width
                <NumberField
                  min={0.5}
                  max={5}
                  step={0.25}
                  value={config.gateLineWidth}
                  onCommit={(gateLineWidth) => style({ gateLineWidth })}
                />
              </label>
              <label>
                Gate labels
                <select
                  value={config.gateLabelFormat ?? "name-percent"}
                  onChange={(e) => style({ gateLabelFormat: e.target.value as IllustrationConfig["gateLabelFormat"] })}
                >
                  <option value="name-percent">Name and percentage</option>
                  <option value="percent">Percentage</option>
                  <option value="number">Number only</option>
                  <option value="name">Name only</option>
                  <option value="none">None</option>
                </select>
              </label>
              <details>
                <summary>Typography</summary>
                {(
                  ["fontTick", "fontAxis", "fontTitle", "fontGate"] as const
                ).map((key) => (
                  <label key={key}>
                    {
                      {
                        fontTick: "Ticks",
                        fontAxis: "Axes",
                        fontTitle: "Headings",
                        fontGate: "Gate labels",
                      }[key]
                    }
                    <NumberField
                      min={8}
                      max={24}
                      integer
                      value={config[key]}
                      onCommit={(size) => style({ [key]: size })}
                    />
                  </label>
                ))}
                <label><input type="checkbox" checked={config.scaleFontsWithPlot} onChange={e => style({ scaleFontsWithPlot: e.target.checked })} />Scale fonts with panel size</label>
                <p>{config.scaleFontsWithPlot ? "Font sizes are specified at a 280 px panel and scale proportionally." : "Font sizes stay fixed when you resize a panel."}</p>
              </details>
            </section>
            <section
              hidden={section !== "export"}
              id="figure-section-export"
              role="tabpanel"
              aria-labelledby="figure-tab-export"
            >
              {onAddFigureToLayout && (
                <div>
                  <button
                    disabled={!figure.sampleIds.length || !figure.populations.length || !figure.plots.length}
                    title="One block on the Layout tab, drawn there as it is here, heatmaps and style included"
                    onClick={() => onAddFigureToLayout(structuredClone(config))}
                  >
                    Add this figure to the Layout tab
                  </button>
                </div>
              )}
              {onAddToLayout && (
                <div className="gl-figure-actions">
                  <button
                    type="button"
                    disabled={!page || !page.panels.some((panel) => panel.plot.type !== "heatmap")}
                    title="One Layout plot per panel of this page, arranged on the Layout tab's current sheet as here"
                    onClick={() => {
                      if (page) addPanelsToLayout(page.panels.filter((panel) => panel.plot.type !== "heatmap"));
                    }}
                  >
                    Add as separate plots to the Layout tab
                  </button>
                </div>
              )}
              <h3>Export current page</h3>
              <p>
                Page {currentPage + 1} of {pages.length || 1}. Export is
                independent of preview zoom.
              </p>
              <label>
                Format
                <select
                  value={exportFormat}
                  onChange={(e) => setExportFormat(e.target.value)}
                >
                  <option value="svg">SVG · vector axes and gates</option>
                  <option value="png">PNG</option>
                  <option value="pdf">PDF · high-resolution raster</option>
                </select>
              </label>
              <label>
                Data-layer resolution
                <NumberField
                  min={72}
                  max={600}
                  integer
                  value={exportDpi}
                  onCommit={setExportDpi}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={exportAll}
                  onChange={(e) => setExportAll(e.target.checked)}
                />
                Draw all events in export
              </label>
              <p>
                SVG keeps labels and gate outlines editable. PDF contains a
                high-resolution image.
              </p>
              <button
                disabled={pending || !validPanels || !!problems.length}
                onClick={() => void exportPage()}
              >
                {exporting ? "Exporting…" : "Export current page"}
              </button>
              {problems.length > 0 && (
                <p role="alert">Resolve unavailable panels before exporting.</p>
              )}
            </section>
          </fieldset>
        </aside>
        <div
          className="gl-figure-inspector-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the figure inspector"
          title="Drag to resize"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            inspectorDrag.current = { x: event.clientX, w: inspectorWidth };
          }}
          onPointerMove={(event) => {
            const drag = inspectorDrag.current;
            if (!drag) return;
            setInspectorWidth(Math.max(220, Math.min(640, drag.w + event.clientX - drag.x)));
          }}
          onPointerUp={() => { inspectorDrag.current = null; }}
          onPointerCancel={() => { inspectorDrag.current = null; }}
        />
        <section className="gl-figure-canvas" aria-label="Figure preview">
          <div className="gl-figure-arrangement">
            <button onClick={() => setSection("arrange")}>
              Rows: {figure.rows.map(dimensionLabel).join(" / ") || "—"}
            </button>
            <button
              aria-label="Swap rows and columns"
              disabled={exporting}
              onClick={() =>
                editFigure({ rows: figure.columns, columns: figure.rows })
              }
            >
              Swap
            </button>
            <button onClick={() => setSection("arrange")}>
              Columns: {figure.columns.map(dimensionLabel).join(" / ") || "—"}
            </button>
            <label>
              Composition
              <select
                disabled={exporting}
                value={figure.composition}
                onChange={(e) =>
                  editFigure({
                    composition: e.target.value as FigureSpec["composition"],
                  })
                }
              >
                <option value="separate">Separate panels</option>
                <option value="overlay">Overlay files</option>
                <option value="pool">Pool events</option>
              </select>
            </label>
          </div>
          <div className="gl-figure-viewbar">
            <button
              disabled={exporting}
              title="Build every panel again from the current gates, files and the Gating tab's axes"
              onClick={() => setRefreshTick((n) => n + 1)}
            >
              Refresh
            </button>
            <button
              disabled={exporting}
              onClick={() =>
                editFigure({
                  rows: ["samples"],
                  columns: ["populations", "plots"],
                  pages: [],
                  composition: "separate",
                })
              }
            >
              Files down rows
            </button>
            <button
              disabled={exporting}
              onClick={() =>
                editFigure({
                  rows: ["populations", "plots"],
                  columns: ["samples"],
                  pages: [],
                  composition: "separate",
                })
              }
            >
              Files across columns
            </button>
            {figure.plots.some((p) => p.type === "heatmap") && (
              <>
                <button
                  disabled={exporting}
                  aria-pressed={config.heatmapClusterRows === true}
                  title="Order the heatmap's rows by average-linkage clustering, with a dendrogram; off, they follow the population order under Arrange"
                  onClick={() => style({ heatmapClusterRows: config.heatmapClusterRows !== true })}
                >
                  Cluster rows
                </button>
                <button
                  disabled={exporting}
                  aria-pressed={config.heatmapClusterColumns === true}
                  title="Order the heatmap's channels by clustering, with a dendrogram; off, they follow the plot order under Plots"
                  onClick={() => style({ heatmapClusterColumns: config.heatmapClusterColumns !== true })}
                >
                  Cluster channels
                </button>
              </>
            )}
            <span role="status">
              {settling
                ? `Preparing figure${prepared.pending ? ` · ${prepared.pending} files remaining` : ""}…`
                : `${new Set(page?.panels.flatMap((p) => p.samples) ?? []).size} of ${selectedSamples.length} files on this page · ${validPanels} panels ready${problems.length ? ` · ${problems.length} need attention` : ""}`}
            </span>
            {selectedPanels.length > 0 && (
              <span className="gl-figure-selection" role="group" aria-label="Selected panels">
                <span>{selectedPanels.length} panel{selectedPanels.length === 1 ? "" : "s"} selected</span>
                {onAddToLayout && (
                  <button
                    type="button"
                    title="As arranged here: rows stay rows and columns stay columns, however wide the page. Click a panel to select it, or drag across panels; Cmd or Ctrl adds, Shift takes the block between; Escape clears."
                    onClick={() => addPanelsToLayout(selectedPanels)}
                  >
                    Add selected panels to the Layout tab
                  </button>
                )}
                <button type="button" onClick={() => setSelectedPanelKeys(new Set())}>Clear</button>
              </span>
            )}
            <span className="gl-figure-flex" />
            <label>
              Panel size
              <NumberField
                disabled={exporting}
                aria-label="Figure panel size"
                min={200}
                max={600}
                step={20}
                integer
                value={figure.panelSize}
                onCommit={(panelSize) => editFigure({ panelSize })}
              />
              px
            </label>
            <label>
              View
              <select
                aria-label="Preview zoom"
                value={zoom}
                onChange={(e) => setZoom(e.target.value)}
              >
                <option value="fit">Fit width · minimum 50%</option>
                <option value="0.5">50%</option>
                <option value="0.75">75%</option>
                <option value="1">100%</option>
                <option value="1.5">150%</option>
                {!["fit", "0.5", "0.75", "1", "1.5"].includes(zoom) && (
                  <option value={zoom}>{Math.round(Number(zoom) * 100)}%</option>
                )}
              </select>
            </label>
          </div>
          {(layout.error || prepared.error || built.error || exportError) && (
            <div className="gl-figure-warning" role="alert">
              {layout.error || prepared.error || built.error || exportError}
            </div>
          )}
          {figure.composition !== "separate" && (
            <div className="gl-figure-note">
              {figure.composition === "pool"
                ? "Events pooled · event-count weighting · no reference-file gate percentages"
                : "Separate coloured file traces · shared axes · gate outlines hidden"}
            </div>
          )}
          {figure.scalePolicy === "individual" &&
            figure.composition === "separate" && (
              <div className="gl-figure-note">
                Axes fit each file independently. Plot positions are not
                directly comparable.
              </div>
            )}
          <div
            className={marquee ? "gl-figure-viewport is-marquee" : "gl-figure-viewport"}
            ref={viewport}
            aria-busy={pending}
            onMouseDown={startMarquee}
          >
            {!shown ? (
              <div className="gl-figure-empty">
                <h3>Build a file / sample comparison</h3>
                <p>Select files and populations, then add plots to repeat.</p>
                <button
                  onClick={() =>
                    setSection(!figure.plots.length ? "plots" : "data")
                  }
                >
                  Choose {!figure.plots.length ? "plots" : "data"}
                </button>
              </div>
            ) : (
              <div
                className="gl-figure-paper"
                ref={paper}
                style={{ zoom: scale, opacity: settling ? 0.55 : 1 }}
              >
                <FigureGrid
                  page={shown.page}
                  panels={shown.panels}
                  config={config}
                  size={figure.panelSize}
                  showGates={figure.showGates}
                  onPanelContextMenu={openPanelMenu}
                  onMatrixContextMenu={openMatrixMenu}
                  selectedPanels={selectedPanelKeys}
                  onPanelClick={onPanelClick}
                  onLabelMove={(gateId, offset, quadrant, flipped) => {
                    // The gate id comes from whichever file's tree the panel drew. The placement
                    // is the gate's own: it goes to the store in the gate's orientation, which
                    // carries it to every tree the gate is drawn in. A figure with no route to
                    // the store keeps it under the id the copies descend from.
                    const owner = Object.values(trees).find((tree) => tree.gates[gateId]);
                    const key = figureLabelKey(owner ? canonicalGateId(gateId, owner, trees) : gateId, quadrant);
                    if (onGateLabelMove && owner) {
                      const move = treeLabelMove(offset, quadrant, !!flipped);
                      onGateLabelMove(owner.id, gateId, move.offset, move.quadrant);
                      if (figure.labelOffsets?.[key]) {
                        const { [key]: _moved, ...rest } = figure.labelOffsets;
                        editFigure({ labelOffsets: Object.keys(rest).length ? rest : undefined });
                      }
                      return;
                    }
                    editFigure({ labelOffsets: { ...figure.labelOffsets, [key]: offset } });
                  }}
                />
              </div>
            )}
            {marquee && <div className="gl-figure-marquee" aria-hidden="true" style={marquee} />}
          </div>
          <ContextMenu menu={panelMenu} onClose={() => setPanelMenu(null)} />
          <footer className="gl-figure-footer">
            <span>
              {selectedSamples.length} files · each uses its assigned hierarchy
            </span>
            <span className="gl-figure-flex" />
            <button
              disabled={!currentPage || pending || exporting}
              onClick={() => setPageIndex(currentPage - 1)}
            >
              Previous
            </button>
            <span>
              Page {currentPage + 1} / {pages.length || 1}
            </span>
            <button
              disabled={currentPage >= pages.length - 1 || pending || exporting}
              onClick={() => setPageIndex(currentPage + 1)}
            >
              Next
            </button>
          </footer>
        </section>
      </div>
    </div>
  );
}

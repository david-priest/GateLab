import { useEffect, useMemo, useRef, useState, type MutableRefObject, type CSSProperties } from "react";
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
  type FigurePopulation,
  type FigureSample,
  type FigureSpec,
  type FigurePage,
  type FigurePanelData,
} from "../engine/figure";
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
import { facetColumns, groupCheckedCount, toggleGroupChecked } from "../engine/sampleFacets";
import type { LayoutDisplayMode, LayoutPlotRecipe } from "../engine/layout";
import { useFigurePanels } from "./useFigurePanels";
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
  onAddToLayout?: (recipes: LayoutPlotRecipe[]) => void;
}
const refKey = (ref: FigurePopulation) =>
  JSON.stringify([ref.hierarchyId, ref.populationId]);
const dimensionLabel = (dimension: FigureDimension) =>
  dimension === "samples"
    ? "files / samples"
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
    [search, setSearch] = useState("");
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
      const pages = layoutFigure(figure, samples, trees);
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
  const applicableFiles = (ref: FigurePopulation) =>
    selectedSamples.filter((s) =>
      figurePopulationApplies(ref, s, trees, figure),
    );
  const unassignedSelections = figure.populations.filter(
    (ref) => !applicableFiles(ref).length,
  );
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
  const metadataFields = [
    ...new Set(samples.flatMap((s) => Object.keys(s.metadata ?? {}))),
  ];
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
              <div className="gl-figure-list">
                {populationOptions
                  .filter(
                    (ref) =>
                      applicableFiles(ref).length ||
                      figure.populations.some((p) => refKey(p) === refKey(ref)),
                  )
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
                        <select
                          value={plot[axis]}
                          onChange={(e) =>
                            editFigure({
                              plots: figure.plots.map((p) =>
                                p.id === plot.id
                                  ? { ...p, [axis]: e.target.value }
                                  : p,
                              ),
                            })
                          }
                        >
                          {!channels.some(([key]) => key === plot[axis]) && (
                            <option value={plot[axis]}>
                              Unavailable channel
                            </option>
                          )}
                          {channels.map(([key, label]) => (
                            <option key={key} value={key}>
                              {label}
                            </option>
                          ))}
                        </select>
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
                      {d.startsWith("metadata:") && (
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
                    if (e.target.value)
                      place(`metadata:${e.target.value}`, "pages");
                  }}
                >
                  <option value="">Choose field…</option>
                  {metadataFields
                    .filter(
                      (field) =>
                        ![
                          ...figure.rows,
                          ...figure.columns,
                          ...figure.pages,
                        ].includes(`metadata:${field}`),
                    )
                    .map((field) => (
                      <option key={field}>{field}</option>
                    ))}
                </select>
              </label>
              <h3>Order populations</h3>
              {figure.populations.map((p, i) => (
                <div className="gl-figure-order" key={refKey(p)}>
                  <span>{p.label}</span>
                  <button
                    disabled={!i}
                    aria-label={`Move ${p.label} earlier`}
                    onClick={() =>
                      editFigure({
                        populations: move(figure.populations, i, -1),
                      })
                    }
                  >
                    ↑
                  </button>
                  <button
                    disabled={i === figure.populations.length - 1}
                    aria-label={`Move ${p.label} later`}
                    onClick={() =>
                      editFigure({
                        populations: move(figure.populations, i, 1),
                      })
                    }
                  >
                    ↓
                  </button>
                </div>
              ))}
              <h3>Order files / samples</h3>
              {selectedSamples.map((s, i) => (
                <div className="gl-figure-order" key={s.id}>
                  <span>{s.name}</span>
                  <button
                    disabled={!i}
                    aria-label={`Move ${s.name} earlier`}
                    onClick={() =>
                      editFigure({ sampleIds: move(figure.sampleIds, i, -1) })
                    }
                  >
                    ↑
                  </button>
                  <button
                    disabled={i === selectedSamples.length - 1}
                    aria-label={`Move ${s.name} later`}
                    onClick={() =>
                      editFigure({ sampleIds: move(figure.sampleIds, i, 1) })
                    }
                  >
                    ↓
                  </button>
                </div>
              ))}
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
                      value={config.heatmapScale ?? "none"}
                      onChange={(e) =>
                        style({
                          heatmapScale: e.target
                            .value as IllustrationConfig["heatmapScale"],
                        })
                      }
                    >
                      <option value="none">Shared transformed intensity</option>
                      <option value="column_minmax">
                        Per plot: minimum–maximum
                      </option>
                      <option value="row_minmax">
                        Per population: minimum–maximum
                      </option>
                      <option value="column_zscore">Per plot: z-score</option>
                    </select>
                  </label>
                  <label>
                    Cell size
                    <input
                      type="number"
                      min={50}
                      max={200}
                      value={config.heatmapCellSize ?? 80}
                      onChange={(e) =>
                        style({
                          heatmapCellSize: Math.max(
                            50,
                            Math.min(200, Number(e.target.value) || 80),
                          ),
                        })
                      }
                    />
                  </label>
                  <p>
                    Statistics use all finite events. Colours are scaled across
                    this page. Numbers always show the unscaled transformed
                    statistic.
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
                      value={config.heatmapPalette ?? "blue_white_yellow_red"}
                      onChange={(e) =>
                        style({
                          heatmapPalette: e.target
                            .value as IllustrationConfig["heatmapPalette"],
                        })
                      }
                    >
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
                <input
                  type="number"
                  min={100}
                  max={50000}
                  step={1000}
                  value={config.maxEvents}
                  onChange={(e) =>
                    style({
                      maxEvents: Math.max(
                        100,
                        Math.min(50000, Number(e.target.value) || 10000),
                      ),
                    })
                  }
                />
              </label>
              <p>
                Preview has a 300,000-point page budget. Counts use every event.
                Export can draw all events.
              </p>
              <label>
                Point size
                <input
                  type="number"
                  min={0.25}
                  max={5}
                  step={0.25}
                  value={config.pointSize}
                  onChange={(e) =>
                    style({
                      pointSize: Math.max(0.25, Number(e.target.value) || 1),
                    })
                  }
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
                    <input
                      type="number"
                      min={0}
                      max={50}
                      value={config.contourThreshold}
                      onChange={(e) =>
                        style({
                          contourThreshold: Math.max(
                            0,
                            Math.min(50, Number(e.target.value)),
                          ),
                        })
                      }
                    />
                  </label>
                  <label>
                    Smoothing (0 = automatic)
                    <input
                      type="number"
                      min={0}
                      max={14}
                      step={0.2}
                      value={config.kdeBandwidth}
                      onChange={(e) =>
                        style({
                          kdeBandwidth: Math.max(0, Number(e.target.value)),
                        })
                      }
                    />
                  </label>
                  <label>Number of contours<input type="number" min={2} max={30} value={config.contourLevels ?? 10} onChange={e => style({ contourLevels: Math.max(2, Math.min(30, Math.round(Number(e.target.value) || 10))) })} /></label>
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
                    <input
                      type="number"
                      min={0.5}
                      max={5}
                      step={0.25}
                      value={config.histLineWidth}
                      onChange={(e) =>
                        style({
                          histLineWidth: Math.max(0.5, Number(e.target.value)),
                        })
                      }
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
                <input
                  type="number"
                  min={0.5}
                  max={5}
                  step={0.25}
                  value={config.gateLineWidth}
                  onChange={(e) =>
                    style({ gateLineWidth: Math.max(0.5, Number(e.target.value)) })
                  }
                />
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
                    <input
                      type="number"
                      min={8}
                      max={24}
                      value={config[key]}
                      onChange={(e) =>
                        style({
                          [key]: Math.max(
                            8,
                            Math.min(24, Number(e.target.value) || 12),
                          ),
                        })
                      }
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
              {onAddToLayout && (
                <div className="gl-figure-actions">
                  <button
                    type="button"
                    disabled={!figure.sampleIds.length || !figure.plots.some((plot) => plot.type !== "heatmap")}
                    title="One Layout plot per file and plot of this figure, on the Layout tab's current sheet"
                    onClick={() => {
                      const recipes: LayoutPlotRecipe[] = [];
                      for (const sampleId of figure.sampleIds) {
                        const source = prepared.sources.find((entry) => entry.id === sampleId);
                        const entry = samples.find((s) => s.id === sampleId);
                        if (!source || !entry) continue;
                        for (const plot of figure.plots) {
                          if (plot.type === "heatmap") continue;
                          const ref = plot.population ?? figure.populations[0];
                          const resolved = ref ? resolveFigurePopulation(ref, source.tree, trees) : null;
                          const populationId = resolved?.id ?? source.tree.root_population_id;
                          if (!populationId) continue;
                          recipes.push({
                            kind: plot.type,
                            sampleId,
                            populationId,
                            xChannel: plot.x,
                            yChannel: plot.type === "histogram" ? null : plot.y,
                            displayMode: (figure.composition === "overlay" ? "scatter" : config.displayMode) as LayoutDisplayMode,
                            title: `${entry.name} · ${plot.name}`,
                          });
                        }
                      }
                      onAddToLayout(recipes);
                    }}
                  >
                    Add these plots to the Layout tab
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
                <input
                  type="number"
                  min={72}
                  max={600}
                  value={exportDpi}
                  onChange={(e) =>
                    setExportDpi(
                      Math.max(
                        72,
                        Math.min(600, Number(e.target.value) || 300),
                      ),
                    )
                  }
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
            <span role="status">
              {settling
                ? `Preparing figure${prepared.pending ? ` · ${prepared.pending} files remaining` : ""}…`
                : `${new Set(page?.panels.flatMap((p) => p.samples) ?? []).size} of ${selectedSamples.length} files on this page · ${validPanels} panels ready${problems.length ? ` · ${problems.length} need attention` : ""}`}
            </span>
            <span className="gl-figure-flex" />
            <label>
              Panel size
              <input
                disabled={exporting}
                aria-label="Figure panel size"
                type="number"
                min={200}
                max={600}
                step={20}
                value={figure.panelSize}
                onChange={(e) =>
                  editFigure({
                    panelSize: Math.max(
                      200,
                      Math.min(600, Number(e.target.value) || 280),
                    ),
                  })
                }
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
            className="gl-figure-viewport"
            ref={viewport}
            aria-busy={pending}
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
                  onLabelMove={(gateId, offset, quadrant) => {
                    // The gate id comes from whichever file's tree the panel drew; the offset is
                    // kept under the id in the tree the copies descend from, so it holds everywhere.
                    const owner = Object.values(trees).find((tree) => tree.gates[gateId]);
                    const key = figureLabelKey(owner ? canonicalGateId(gateId, owner, trees) : gateId, quadrant);
                    editFigure({ labelOffsets: { ...figure.labelOffsets, [key]: offset } });
                  }}
                />
              </div>
            )}
          </div>
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

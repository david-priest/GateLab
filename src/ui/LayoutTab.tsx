import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { SearchableSelect } from "./SearchableSelect";
import Moveable, {
  type OnDrag,
  type OnDragEnd,
  type OnDragGroup,
  type OnDragGroupEnd,
  type OnDragGroupStart,
  type OnDragStart,
  type OnResize,
  type OnResizeEnd,
  type OnResizeGroup,
  type OnResizeGroupEnd,
} from "react-moveable";
import Selecto, { type OnDragStart as OnSelectoDragStart, type OnSelectEnd } from "react-selecto";
import type { OnClickGroup } from "react-moveable";
import type { Sample } from "../engine/sample";
import type { CoreState, GatingDerived } from "../store";
import {
  figureHierarchies,
  resolveFigurePopulation, resolvePopulationInTree,
  type FigureSample,
  type FigureSource,
} from "../engine/figure";
import { useFigureSources } from "./useFigureSources";
import type { StoredHierarchy } from "../engine/hierarchies";
import {
  applyLayoutPage,
  cloneLayoutWorkspace,
  createLayoutSheet,
  LAYOUT_PAGE_PRESETS,
  MAX_PAGE_GRID,
  mmToPx,
  nextLayoutItemPosition,
  layoutItemMinimum,
  pageForPreset,
  pageOrigins,
  pageSizeMm,
  pageSizePx,
  LAYOUT_STYLE_RANGES,
  effectiveLayoutStyle,
  normalizeLayoutStyle,
  type LayoutDisplayMode,
  type LayoutPlotStyle,
  type LayoutStyleNumber,
  type LayoutOrientation,
  type LayoutPage,
  type LayoutPagePreset,
  type LayoutItem,
  type LayoutPlotRecipe,
  type LayoutChartRecipe,
  type LayoutFigureRecipe,
  type LayoutProportionsRecipe,
  isPlotLikeRecipe,
  layoutItemZoom,
  type LayoutRecipe,
  type LayoutSheet,
  type LayoutStrategyRecipe,
  type LayoutWorkspace,
} from "../engine/layout";
import type { IllustrationConfig } from "../engine/workspace";
import { buildIllustrationPayload } from "../engine/illustration";
import {
  computeGatingStrategy,
  buildStrategyPayload,
} from "../engine/strategy";
import { populationTreeOrder } from "../engine/populations";
import { loadMiniPlots } from "../plots/loadPlots";
import { composeSheetPages, writeComposedPages, type ComposedPage, type LayoutExportFormat } from "../plots/layoutExport";
import { DEFAULT_ITERATION, expandLayoutSheet, followsIteration, iterationUnits, populationUnits, templateFrame, type DescribeBoundPlot, type LayoutIteration, type LayoutPage as ExpandedPage, type LayoutPageItem } from "../engine/layoutBatch";
import { automaticTitleTemplate, fieldsFromTemplate, plotTitle, plotTitleContext, templateFromFields, titleFields, TITLE_PLACEHOLDERS, TITLE_PRESETS, TITLE_SEPARATORS } from "../engine/layoutTitle";
import { alignItems, distributeItems, fitContentToPage, fitPageToContent, type AlignHow, type DistributeHow } from "../engine/layoutArrange";
import { useI18n } from "./i18n";
import { historyShortcutAction } from "./historyShortcuts";
import { NumberField } from "./NumberField";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import type { MenuEntry } from "./MenuButton";
import { CHART_STATISTIC_LABELS, LayoutChart, chartData } from "./LayoutChart";
import { LayoutFigureSurface, figureBlockFrame } from "./LayoutFigure";
import { LayoutProportionsSurface, proportionsBlockFrame, proportionsSampleRefs } from "./LayoutProportions";
import type { DivisionProfileLike } from "../engine/factors";
import { buildProportionsModel, type ProportionsSettings } from "../engine/proportionsModel";

export interface LayoutSampleView {
  id: string;
  name: string;
  sample: Sample;
  derived: GatingDerived;
  tree: StoredHierarchy;
}

interface Props {
  workspace: LayoutWorkspace;
  onChange: (workspace: LayoutWorkspace) => void;
  samples: readonly FigureSample[];
  /** The files checked in the Samples pane, the workspace's groups and their membership, and the metadata columns: what an iteration draws from. */
  checkedSampleIds?: readonly string[];
  groups?: readonly { id: string; name: string }[];
  fileGroups?: Readonly<Record<string, string>>;
  metadataColumns?: readonly string[];
  /** The Metadata tab's population table, by population id: what {popmeta:field} reads in titles and text. */
  populationMetadata?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  activeSampleId: string | null;
  activePopulationId: string | null;
  state: CoreState;
  globalScales: Record<string, [number, number]>;
  defaultX: string;
  defaultY: string;
  illustrationConfig: IllustrationConfig | null;
  /** Load a figure block's figure into the Illustration tab, to edit it there. */
  onOpenInIllustration?: (config: IllustrationConfig) => void;
  /** The Plotting tab's chart as it is now, for a chart block; the files' division profiles, for a division chart. */
  plottingSettings?: () => ProportionsSettings;
  divisionProfiles?: Readonly<Record<string, DivisionProfileLike>>;
  /** Load a chart block's settings into the Plotting tab, to edit them there. */
  onOpenInPlotting?: (settings: ProportionsSettings) => void;
  dataRevision: string | number;
  densityColorPower: number;
  onOpenInGating: (recipe: LayoutPlotRecipe | LayoutStrategyRecipe) => void;
}

/** The renderer's font sizes from a style. */
const fontSizesOf = (style: LayoutPlotStyle) => ({
  tick: style.fontTick,
  axis_label: style.fontAxis,
  gate_label: style.fontGate,
  title: style.fontTitle,
});
const DIMENSION_LABELS = { x: "X (px)", y: "Y (px)", width: "Width (px)", height: "Height (px)" } as const;
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
const SNAP_GRID = 10;
/** A stable empty page, so nothing re-renders on its identity. */
const EMPTY_PAGE: ExpandedPage = { index: 0, units: [], items: [] };
const NO_DIVISION_PROFILES: Readonly<Record<string, DivisionProfileLike>> = {};
const SNAP_DIRECTIONS = { top: true, left: true, bottom: true, right: true, center: true, middle: true };
const ALIGNMENTS: { how: AlignHow; label: string; title: string }[] = [
  { how: "left", label: "Left", title: "Align the left edges (one item: to the page margin)" },
  { how: "centerX", label: "Centre", title: "Align the horizontal centres (one item: to the page centre)" },
  { how: "right", label: "Right", title: "Align the right edges (one item: to the page margin)" },
  { how: "top", label: "Top", title: "Align the top edges (one item: to the page margin)" },
  { how: "centerY", label: "Middle", title: "Align the vertical centres (one item: to the page centre)" },
  { how: "bottom", label: "Bottom", title: "Align the bottom edges (one item: to the page margin)" },
];
const DISTRIBUTIONS: { how: DistributeHow; label: string; title: string }[] = [
  { how: "horizontal", label: "Spread ↔", title: "Equal gaps between three or more items, left to right" },
  { how: "vertical", label: "Spread ↕", title: "Equal gaps between three or more items, top to bottom" },
];
/** The frame an element shows now, from its inline style: what Moveable moved or resized. */
function frameOfElement(el: HTMLElement): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round(parseFloat(el.style.left) || 0),
    y: Math.round(parseFloat(el.style.top) || 0),
    width: Math.round(parseFloat(el.style.width) || el.offsetWidth),
    height: Math.round(parseFloat(el.style.height) || el.offsetHeight),
  };
}

/**
 * A title GateLab baked into a plot added from Illustration before the sheet template existed:
 * "population · file", the plot's name after. Not the user's, so the sheet's template applies to
 * it as if it were empty; a title typed under Items still wins.
 */
export function isBakedTitle(title: string, population: string, fileNames: readonly string[]): boolean {
  if (!population) return false;
  return fileNames.some((file) => !!file && (title === `${population} · ${file}` || title.startsWith(`${population} · ${file} · `)));
}

function itemTitle(
  item: LayoutItem,
  samples: readonly LayoutSampleView[],
  _state: CoreState,
): string {
  const recipe = item.recipe;
  if (recipe.kind === "text") return recipe.text.split("\n")[0] || "Text";
  if (recipe.title?.trim()) return recipe.title.trim();
  if (recipe.kind === "figure") return recipe.illustration.figure?.name?.trim() || "Figure";
  if (recipe.kind === "proportions") return recipe.settings.plotType === "box" ? "Boxplot" : "Composition";
  const sample = samples.find(({ id }) => id === recipe.sampleId);
  const population = sample?.tree.populations[recipe.populationId];
  if (recipe.kind === "chart") return `${population?.name ?? "Population"} · ${CHART_STATISTIC_LABELS[recipe.statistic]}`;
  if (recipe.kind === "strategy") {
    return `${population?.name ?? "Population"} strategy`;
  }
  return `${population?.name ?? "Population"} · ${sample?.name ?? "FCS"}`;
}

function LayoutPlotSurface({
  item,
  samples,
  state: activeState,
  globalScales,
  dataRevision,
  densityColorPower,
  style,
  canvasScale,
  titleTemplate,
  describe,
}: Readonly<{
  item: LayoutPageItem;
  samples: readonly LayoutSampleView[];
  state: CoreState;
  globalScales: Record<string, [number, number]>;
  dataRevision: string | number;
  densityColorPower: number;
  /** Canvas pixels per CSS pixel: the display's ratio times the page zoom, so a zoomed page stays sharp. */
  canvasScale: number;
  /** The sheet's style with this item's own values over it. */
  style: LayoutPlotStyle;
  /** What the plot is titled: its own title, else the sheet's template; placeholders filled from `describe`. */
  titleTemplate: string;
  describe: DescribeBoundPlot;
}>) {
  const hostRef = useRef<HTMLDivElement>(null);
  // A chart, a figure and a Plotting chart have surfaces of their own; this one takes plots and strategies.
  const recipe = item.recipe as Exclude<LayoutRecipe, LayoutChartRecipe | LayoutFigureRecipe | LayoutProportionsRecipe>;
  const styleKey = JSON.stringify(style);
  const source =
    recipe.kind === "text"
      ? null
      : (samples.find(({ id }) => id === recipe.sampleId) ?? null);
  const state = source ? { ...activeState, ...source.tree } : activeState;
  // An item drawn for another file than its template's: the population is the template's,
  // followed through provenance into this file's tree, so a tailored or group copy shows its
  // own gate and a file without the population says so rather than drawing another.
  const templateSource = recipe.kind !== "text" && item.templateSampleId && item.templateSampleId !== recipe.sampleId
    ? (samples.find(({ id }) => id === item.templateSampleId) ?? null)
    : null;
  // The population as named, or followed into this file's tree from the tree the id belongs to
  // (a reopened workspace can put the file on another copy of the tree than the one the plot
  // was added from), so a plot never says its population is unavailable while the file has it.
  const resolvedPopulation = (() => {
    if (recipe.kind === "text" || !source) return { id: recipe.kind === "text" ? "" : recipe.populationId, missing: false };
    return resolvePopulationInTree(recipe.populationId, source.tree, figureHierarchies(activeState), templateSource?.tree.id);
  })();
  const populationId = resolvedPopulation.id;
  const missingPopulationName = resolvedPopulation.missing
    ? (templateSource?.tree.populations[recipe.kind === "text" ? "" : recipe.populationId]?.name ?? "the population")
    : null;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || recipe.kind === "text") return;
    const timer = window.setTimeout(() => {
      host.innerHTML = "";
      if (!source) {
        host.textContent =
          "The referenced file is unavailable or still loading.";
        host.className = "gl-layout-plot-host is-missing";
        return;
      }
      const population = state.populations[populationId];
      if (missingPopulationName || !population) {
        host.textContent = missingPopulationName
          ? `${source.name} has no population corresponding to ${missingPopulationName}.`
          : "The referenced population is unavailable.";
        host.className = "gl-layout-plot-host is-missing";
        return;
      }
      host.className = "gl-layout-plot-host";
      // The title from its template: the plot's own, else the sheet's, else what differs across the page.
      const context = describe({ ...recipe, populationId });
      const fillTitle = (template: string) => (context ? plotTitle(template, context) : template);
      const availableWidth = Math.max(120, item.width - 8);
      const availableHeight = Math.max(120, item.height - 8);

      if (recipe.kind === "strategy") {
        const steps = computeGatingStrategy(
          source.sample,
          state.gates,
          state.populations,
          state.root_population_id ?? "",
          populationId,
          { fullPath: recipe.fullPath, maxEvents: style.maxEvents },
        );
        // The strip fills its frame: of every column count, the one whose rows and columns give
        // the largest plot that fits both ways. A wider frame spreads the steps out, a taller one
        // stacks them and draws them larger; resizing the frame scales the strip.
        const gap = 8, titleHeight = 26;
        const stepCount = Math.max(1, steps.length);
        let columns = 1, plotSize = 0;
        for (let candidate = 1; candidate <= stepCount; candidate++) {
          const rows = Math.ceil(stepCount / candidate);
          const cellWidth = Math.floor((availableWidth - gap * (candidate - 1)) / candidate);
          const cellHeight = Math.floor((availableHeight - titleHeight - gap * (rows - 1)) / rows);
          const size = Math.min(cellWidth, cellHeight);
          if (size > plotSize) { plotSize = size; columns = candidate; }
        }
        plotSize = Math.max(100, Math.min(800, plotSize));
        const payload = buildStrategyPayload(
          source.sample,
          steps,
          null,
          globalScales,
          {
            gateView: ["forward"],
            displayMode: recipe.displayMode,
            maxEvents: style.maxEvents,
            nColumns: columns,
            plotSize,
            fitToColumns: false,
            contourThreshold: style.contourThreshold,
            pointAlpha: style.pointAlpha,
            densityColorPower,
            pointSize: style.pointSize,
            kdeBandwidth: style.kdeBandwidth,
            pubStyle: style.pubStyle,
            gateLineWidth: style.gateLineWidth,
            gateLabelFormat: style.gateLabels,
            fontSizes: fontSizesOf(style),
            contextTitle: fillTitle(recipe.title?.trim() || "{population}"),
          },
        );
        host.id = `layout-strategy-${item.id}`;
        for (const plot of Object.values((payload as { plots?: Record<string, Record<string, unknown>> }).plots ?? {})) plot.canvas_scale = canvasScale;
        loadMiniPlots().renderStrategyGrid(host.id, payload);
        return;
      }

      const plotSize = Math.max(120, Math.min(availableWidth, availableHeight));
      const yChannel = recipe.kind === "histogram" ? null : recipe.yChannel;
      const payload = buildIllustrationPayload(
        source.sample,
        state.gates,
        state.gate_order,
        state.populations,
        source.derived.masks,
        source.derived.stats.event_count,
        [populationId],
        [recipe.xChannel],
        yChannel,
        globalScales,
        {
          displayMode: recipe.displayMode,
          maxEvents: style.maxEvents,
          nColumns: 1,
          plotSize,
          fitToColumns: false,
          contourThreshold: style.contourThreshold,
          pointAlpha: style.pointAlpha,
          densityColorPower,
          pointSize: style.pointSize,
          kdeBandwidth: style.kdeBandwidth,
          colorByPop: false,
          overlayPops: false,
          populationColors: {},
          histLineWidth: style.histLineWidth,
          histFill: style.histFill,
          histFillAlpha: style.histFillAlpha,
          histOverlayMode: "front_opaque",
          histLayout: "grid",
          ridgeOverlap: 0.7,
          ridgeColGap: 8,
          ridgeGradient: false,
          pubStyle: style.pubStyle,
          gateLineWidth: style.gateLineWidth,
          gateLabelFormat: style.gateLabels,
          fontSizes: fontSizesOf(style),
          scaleFontsWithPlot: true,
        },
      ) as {
        plots?: Record<string, Record<string, unknown>>;
        gate_overlays?: Record<string, unknown>;
      };
      const key = `${populationId}|${recipe.xChannel}`;
      const plot = payload.plots?.[key];
      if (!plot) {
        host.textContent =
          "No events are available for this FCS/population combination.";
        host.className = "gl-layout-plot-host is-missing";
        return;
      }
      loadMiniPlots().renderMiniPlot(host, {
        ...plot,
        display_mode: recipe.displayMode,
        plot_size: plotSize,
        canvas_scale: canvasScale,
        contour_threshold: style.contourThreshold,
        point_alpha: style.pointAlpha,
        density_color_power: densityColorPower,
        point_size: style.pointSize,
        kde_bandwidth: style.kdeBandwidth,
        hist_line_width: style.histLineWidth,
        hist_fill: style.histFill,
        hist_fill_alpha: style.histFillAlpha,
        hist_overlay_mode: "front_opaque",
        title: fillTitle(titleTemplate),
        contour_levels: style.contourLevels,
        font_sizes: fontSizesOf(style),
        gate_style: { pub_style: style.pubStyle, line_width: style.gateLineWidth, label_format: style.gateLabels },
        pop_color: "#334155",
        gates: payload.gate_overlays?.[key] ?? [],
      });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [
    dataRevision,
    densityColorPower,
    styleKey,
    globalScales,
    item.height,
    item.id,
    item.width,
    recipe,
    source,
    state.gate_order,
    state.gate_version,
    state.gates,
    state.stored_hierarchies,
    state.populations,
    state.root_population_id,
    populationId,
    missingPopulationName,
    canvasScale,
    titleTemplate,
    describe,
  ]);

  if (recipe.kind === "text") {
    return (
      <div
        className="gl-layout-text-surface"
        style={{ fontSize: recipe.fontSize, fontWeight: recipe.bold ? 700 : 400 }}
      >
        {recipe.text}
      </div>
    );
  }
  return <div ref={hostRef} className="gl-layout-plot-host" />;
}

function LayoutItemFrame({
  item,
  templateText,
  selected,
  samples,
  state,
  globalScales,
  dataRevision,
  densityColorPower,
  style,
  titleTemplate,
  describe,
  checkedSampleIds,
  metadataById,
  files,
  sources,
  divisionProfiles,
  canvasScale,
  onDelete,
  onOpenInGating,
  onTextChange,
  onTextFocus,
  onTextEscape,
}: Readonly<{
  item: LayoutPageItem;
  canvasScale: number;
  /** The text as written on the template, with its placeholders, for editing. */
  templateText?: string;
  selected: boolean;
  samples: readonly LayoutSampleView[];
  state: CoreState;
  globalScales: Record<string, [number, number]>;
  dataRevision: string | number;
  densityColorPower: number;
  style: LayoutPlotStyle;
  /** What a plot is titled when it has no title of its own, and what the placeholders read. */
  titleTemplate: string;
  describe: DescribeBoundPlot;
  /** What a chart draws from: the files checked in the Samples pane and each file's metadata. */
  checkedSampleIds: readonly string[];
  metadataById: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>;
  /** The workspace's files as the Illustration tab sees them, and the prepared sources, for a figure block. */
  files: readonly FigureSample[];
  sources: readonly FigureSource[];
  /** The files' division profiles, for a chart block of division categories. */
  divisionProfiles: Readonly<Record<string, DivisionProfileLike>>;
  onDelete: () => void;
  onOpenInGating: () => void;
  /** The text as committed, with the height its lines need, so the frame can grow to show them. */
  onTextChange: (text: string, contentHeight: number) => void;
  /** The text editor took focus: a click on a text block's words selects the block. */
  onTextFocus: () => void;
  /** Escape in the text editor: the block stays selected and the page takes the keyboard. */
  onTextEscape: () => void;
}>) {
  const { t } = useI18n();
  // A zoomed item is drawn at the size it had and scaled as a whole, so what Fit content to page
  // shrank keeps its fonts, gates and margins in proportion; the frame is the zoomed size.
  const zoom = layoutItemZoom(item);
  const inner = zoom === 1 ? item : { ...item, width: Math.max(1, Math.round(item.width / zoom)), height: Math.max(1, Math.round(item.height / zoom)) };
  return (
    <article
      data-item-id={item.id}
      data-template-id={item.templateId}
      data-zoom={zoom === 1 ? undefined : zoom}
      className={`gl-layout-item${selected ? " is-selected" : ""}${item.showFrame ? " has-frame" : ""}${item.recipe.kind === "text" ? " is-text" : ""}${item.locked ? " is-locked" : ""}`}
      style={{
        left: item.x,
        top: item.y,
        width: item.width,
        height: item.height,
        zIndex: item.z,
      }}
    >
      <header className="gl-layout-item-head">
        <span title={itemTitle(item, samples, state)}>
          {item.locked ? "🔒 " : ""}{itemTitle(item, samples, state)}
        </span>
        <div>
          {isPlotLikeRecipe(item.recipe) && (
            <button
              type="button"
              className="gl-layout-item-action"
              title={t("Open in Gating")}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onOpenInGating}
            >
              ↗
            </button>
          )}
          <button
            type="button"
            className="gl-layout-item-action"
            title={t("Remove from layout")}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onDelete}
          >
            ×
          </button>
        </div>
      </header>
      <div className="gl-layout-item-body" style={zoom === 1 ? undefined : { zoom, width: inner.width, height: inner.height }}>
      {item.recipe.kind === "text" ? (
        <LayoutTextEditor
          text={item.recipe.text}
          templateText={templateText ?? item.recipe.text}
          fontSize={item.recipe.fontSize}
          bold={item.recipe.bold}
          onCommit={onTextChange}
          onFocus={onTextFocus}
          onEscape={onTextEscape}
        />
      ) : item.recipe.kind === "figure" ? (
        <LayoutFigureSurface
          recipe={item.recipe}
          files={files}
          sources={sources}
          state={state}
          globalScales={globalScales}
          width={Math.max(120, inner.width - 8)}
          height={Math.max(80, inner.height - 8)}
        />
      ) : item.recipe.kind === "proportions" ? (
        <LayoutProportionsSurface
          recipe={item.recipe}
          samples={files}
          state={state}
          metadataById={metadataById}
          divisionProfiles={divisionProfiles}
          width={Math.max(120, inner.width - 8)}
          height={Math.max(80, inner.height - 8)}
          containerId={`layout-proportions-${item.id}`}
        />
      ) : item.recipe.kind === "chart" ? (
        <div className="gl-layout-plot-host gl-layout-chart-host">
          <LayoutChart
            data={chartData(item.recipe, samples, metadataById, checkedSampleIds, state)}
            recipe={item.recipe}
            style={style}
            width={Math.max(120, inner.width - 8)}
            height={Math.max(80, inner.height - 8)}
            title={item.recipe.title?.trim() || itemTitle(item, samples, state)}
          />
        </div>
      ) : (
        <LayoutPlotSurface
          item={inner}
          samples={samples}
          state={state}
          globalScales={globalScales}
          dataRevision={dataRevision}
          densityColorPower={densityColorPower}
          style={style}
          canvasScale={canvasScale}
          titleTemplate={titleTemplate}
          describe={describe}
        />
      )}
      </div>
    </article>
  );
}

/** The numeric style fields, in the order shown; the two booleans follow them. */
const LAYOUT_STYLE_NUMBERS: readonly { key: LayoutStyleNumber; label: string; step: number; integer?: boolean }[] = [
  { key: "pointSize", label: "Point size", step: 0.1 },
  { key: "pointAlpha", label: "Point opacity", step: 0.05 },
  { key: "maxEvents", label: "Events drawn", step: 1000, integer: true },
  { key: "contourThreshold", label: "Contour threshold (%)", step: 0.5 },
  { key: "contourLevels", label: "Contour levels", step: 1, integer: true },
  { key: "kdeBandwidth", label: "Smoothing (0 = automatic)", step: 0.1 },
  { key: "gateLineWidth", label: "Gate line width", step: 0.25 },
  { key: "histLineWidth", label: "Histogram line width", step: 0.2 },
  { key: "histFillAlpha", label: "Histogram fill opacity", step: 0.05 },
  { key: "fontTick", label: "Tick font", step: 1 },
  { key: "fontAxis", label: "Axis font", step: 1 },
  { key: "fontTitle", label: "Title font", step: 1 },
  { key: "fontGate", label: "Gate label font", step: 1 },
];

/**
 * The style fields, showing the effective value of each; a field the record sets itself is
 * marked. Used for the sheet's style and, under Items, for an item's own values over it.
 */
function LayoutStyleFields({
  effective,
  own,
  onChange,
}: Readonly<{
  effective: LayoutPlotStyle;
  own: Partial<LayoutPlotStyle>;
  onChange: (patch: Partial<LayoutPlotStyle>) => void;
}>) {
  const { t } = useI18n();
  return (
    <div className="gl-layout-style-fields">
      {LAYOUT_STYLE_NUMBERS.map(({ key, label, step, integer }) => (
        <label key={key} className={"gl-field-inline" + (key in own ? " is-own" : "")}>
          {t(label)}
          <NumberField
            aria-label={t(label)}
            value={effective[key]}
            min={LAYOUT_STYLE_RANGES[key][0]}
            max={LAYOUT_STYLE_RANGES[key][1]}
            step={step}
            integer={integer}
            onCommit={(value) => onChange({ [key]: value })}
          />
        </label>
      ))}
      <label className={"gl-field-inline" + ("gateLabels" in own ? " is-own" : "")}>
        {t("Gate labels")}
        <select
          aria-label={t("Gate labels")}
          value={effective.gateLabels}
          onChange={(event) => onChange({ gateLabels: event.target.value as LayoutPlotStyle["gateLabels"] })}
        >
          <option value="name-percent">{t("Name and percentage")}</option>
          <option value="percent">{t("Percentage")}</option>
          <option value="number">{t("Number only")}</option>
          <option value="name">{t("Name only")}</option>
          <option value="none">{t("None")}</option>
        </select>
      </label>
      <label className={"gl-check" + ("pubStyle" in own ? " is-own" : "")}>
        <input
          type="checkbox"
          checked={effective.pubStyle}
          onChange={(event) => onChange({ pubStyle: event.target.checked })}
        />
        {t("Publication style (black gates and labels)")}
      </label>
      <label className={"gl-check" + ("histFill" in own ? " is-own" : "")}>
        <input
          type="checkbox"
          checked={effective.histFill}
          onChange={(event) => onChange({ histFill: event.target.checked })}
        />
        {t("Fill histograms")}
      </label>
    </div>
  );
}

function LayoutTextEditor({
  text,
  templateText,
  fontSize,
  bold,
  onCommit,
  onFocus,
  onEscape,
}: {
  /** The text as shown: the template's with its placeholders filled in. */
  text: string;
  /** The text as written, which is what editing changes. */
  templateText: string;
  fontSize: number;
  bold?: boolean;
  onCommit: (text: string, contentHeight: number) => void;
  onFocus: () => void;
  onEscape: () => void;
}) {
  const [draft, setDraft] = useState(text);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(text); }, [text, editing]);
  return (
    <textarea
      className="gl-layout-text-surface"
      aria-label="Layout text"
      value={draft}
      style={{ fontSize, fontWeight: bold ? 700 : 400 }}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => {
        // While editing, the placeholders themselves are shown, so they stay in the text.
        setEditing(true);
        setDraft(templateText);
        onFocus();
      }}
      onBlur={(event) => {
        setEditing(false);
        if (draft !== templateText) onCommit(draft, event.currentTarget.scrollHeight);
        else setDraft(text);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          setDraft(templateText);
          event.currentTarget.blur();
          onEscape();
        }
      }}
    />
  );
}

export function LayoutTab({
  workspace,
  onChange,
  samples: files,
  checkedSampleIds = [],
  groups = [],
  fileGroups = {},
  metadataColumns = [],
  populationMetadata,
  activeSampleId,
  activePopulationId,
  state,
  globalScales,
  defaultX,
  defaultY,
  illustrationConfig,
  onOpenInIllustration,
  plottingSettings,
  divisionProfiles = NO_DIVISION_PROFILES,
  onOpenInPlotting,
  dataRevision,
  densityColorPower,
  onOpenInGating,
}: Readonly<Props>) {
  const { t } = useI18n();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [snapToGrid, setSnapToGrid] = useState(true);
  // The elements Moveable acts on and snaps to are read from the page after each commit.
  const [pageEl, setPageEl] = useState<HTMLElement | null>(null);
  const [canvasEl, setCanvasEl] = useState<HTMLDivElement | null>(null);
  const [selectedElements, setSelectedElements] = useState<HTMLElement[]>([]);
  const [guideElements, setGuideElements] = useState<HTMLElement[]>([]);
  const moveableRef = useRef<Moveable>(null);
  const selectoRef = useRef<Selecto>(null);
  const [renamingSheetId, setRenamingSheetId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [insertFileId, setInsertFileId] = useState(
    activeSampleId ?? files[0]?.id ?? "",
  );
  const [section, setSection] = useState("item");
  const [preview, setPreview] = useState(false);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // The plots are drawn at the display's pixel ratio times the page zoom, so a zoomed-in page
  // stays sharp; the zoom is taken once it has settled, so a zoom gesture does not redraw every
  // plot at each step.
  const [settledZoom, setSettledZoom] = useState(zoom);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettledZoom(zoom), 250);
    return () => window.clearTimeout(timer);
  }, [zoom]);
  const canvasScale = Math.min(4, Math.max(1, (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1) * settledZoom));
  const [exportFormat, setExportFormat] = useState<LayoutExportFormat>("pdf");
  const [exporting, setExporting] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  /** Selecting also focuses the page, so the keyboard acts on the selection at once. */
  const selectMany = (ids: string[]) => {
    setSelectedIds(ids);
    canvasRef.current?.focus({ preventScroll: true });
  };
  const selectItem = (id: string | null) => selectMany(id ? [id] : []);
  const sourceResult = useFigureSources(
    files,
    files.map((file) => file.id),
    state,
    dataRevision,
  );
  const samples: LayoutSampleView[] = sourceResult.current
    ? sourceResult.sources.map((source) => ({
        ...source,
        derived: source.gating,
      }))
    : [];
  const metadataById = useMemo(
    () => Object.fromEntries(files.map((file) => [file.id, file.metadata])) as Record<string, Readonly<Record<string, string>> | undefined>,
    [files],
  );
  /** The per-file sources are prepared off the render path; until then nothing can be placed. */
  const ready = files.length === 0 || (sourceResult.current && sourceResult.pending === 0);
  const undoRef = useRef<LayoutWorkspace[]>([]);
  const redoRef = useRef<LayoutWorkspace[]>([]);
  const activeSheet =
    workspace.sheets.find(({ id }) => id === workspace.activeSheetId) ??
    workspace.sheets[0];
  const iteration: LayoutIteration = activeSheet?.iteration ?? DEFAULT_ITERATION;
  // A population iteration draws on one file: that of the first item that follows it, else the
  // file new plots take.
  const iterationSource = useMemo(() => {
    const followed = activeSheet?.items.find((item) => isPlotLikeRecipe(item.recipe) && item.recipe.iterated === true);
    const sampleId = followed && "sampleId" in followed.recipe ? followed.recipe.sampleId : activeSampleId;
    return samples.find(({ id }) => id === sampleId) ?? samples[0] ?? null;
  }, [activeSheet, samples, activeSampleId]);
  const units = useMemo(
    () =>
      iteration.mode === "populations"
        ? iterationSource
          ? populationUnits(iteration, iterationSource.tree, files.find(({ id }) => id === iterationSource.id) ?? iterationSource)
          : []
        : iterationUnits(iteration, files, checkedSampleIds, groups, fileGroups),
    [iteration, files, checkedSampleIds, groups, fileGroups, iterationSource],
  );
  /** What a plot's placeholders read: its file (display id, name, metadata), its population (followed into the file's tree when drawn for another) and its count. */
  const describePlot: DescribeBoundPlot = useCallback((recipe, templateSampleId) => {
    const file = files.find(({ id }) => id === recipe.sampleId) ?? null;
    const view = samples.find(({ id }) => id === recipe.sampleId) ?? null;
    let populationId = recipe.populationId;
    if (view && templateSampleId && templateSampleId !== recipe.sampleId) {
      const templateView = samples.find(({ id }) => id === templateSampleId);
      if (templateView && templateView.tree.id !== view.tree.id) {
        const resolved = resolveFigurePopulation({ hierarchyId: templateView.tree.id, populationId: recipe.populationId, label: "" }, view.tree, figureHierarchies(state));
        if (resolved.id) populationId = resolved.id;
      }
    }
    const population = view?.tree.populations[populationId];
    const count = view?.derived.stats.event_count[populationId];
    return plotTitleContext(
      recipe.kind === "strategy" ? {} : recipe,
      file ? { name: file.name, fileName: file.fileName ?? file.name, metadata: file.metadata } : null,
      population ? { id: populationId, name: population.name } : null,
      typeof count === "number" ? count : undefined,
      populationMetadata,
    );
  }, [files, samples, state, populationMetadata]);
  const pages: ExpandedPage[] = useMemo(
    () => (activeSheet ? expandLayoutSheet(activeSheet, units, describePlot) : []),
    [activeSheet, units, describePlot],
  );
  const [pageIndex, setPageIndex] = useState(0);
  /** "Custom template…" chosen under Style: the builder shows even while its text still matches a preset. */
  const [customTitles, setCustomTitles] = useState(false);
  /** The separator the title builder puts between fields; kept when the template is not the builder's shape. */
  const [builderSeparator, setBuilderSeparator] = useState(" · ");
  const populationMetadataFields = useMemo(
    () => [...new Set(Object.values(populationMetadata ?? {}).flatMap((fields) => Object.keys(fields)))].sort(),
    [populationMetadata],
  );
  const builderFields = useMemo(() => titleFields(metadataColumns, populationMetadataFields), [metadataColumns, populationMetadataFields]);
  const currentPageIndex = Math.min(pageIndex, Math.max(0, pages.length - 1));
  const currentPage: ExpandedPage = pages[currentPageIndex] ?? EMPTY_PAGE;
  // What the page's plots are titled: the sheet's template, else what differs across the page.
  const sheetTitleTemplate = activeSheet?.titleTemplate?.trim() || automaticTitleTemplate(
    currentPage.items.flatMap((item) => isPlotLikeRecipe(item.recipe)
      ? [{ sampleId: item.recipe.sampleId, populationId: item.recipe.populationId, label: item.recipe.kind === "strategy" ? undefined : item.recipe.label }]
      : []),
  );
  useEffect(() => {
    if (pageIndex !== currentPageIndex) setPageIndex(currentPageIndex);
  }, [pageIndex, currentPageIndex]);
  // Selection holds the ids of the items on the page; on a tiled page a copy's id carries its
  // tile, so the template item it stands for is the part before "::".
  const templateIdOf = (id: string) => id.split("::")[0];
  const selectedTemplateIds = [...new Set(selectedIds.map(templateIdOf))];
  const selectedItems = activeSheet?.items.filter(({ id }) => selectedTemplateIds.includes(id)) ?? [];
  const selectedItem = selectedItems.length === 1 ? selectedItems[0] : null;
  const selectedPageItem = selectedItem ? currentPage.items.find((item) => item.templateId === selectedItem.id) ?? null : null;
  /** A plot's own title, typed under Items; empty for none, or for one GateLab baked in before the template existed. */
  const ownTitleOf = (item: LayoutItem, templateSampleId?: string): string => {
    if (!isPlotLikeRecipe(item.recipe)) return "";
    const title = item.recipe.title?.trim() ?? "";
    if (!title) return "";
    const context = describePlot(item.recipe, templateSampleId);
    return context && isBakedTitle(title, context.population, [context.file, context.sample]) ? "" : title;
  };
  const selectedTitlePreview = selectedPageItem && isPlotLikeRecipe(selectedPageItem.recipe)
    ? plotTitle(sheetTitleTemplate, describePlot(selectedPageItem.recipe, selectedPageItem.templateSampleId) ?? { population: "", file: "", sample: "", x: "", y: "" })
    : "";
  const selectionLocked = selectedItems.some((item) => item.locked);

  useEffect(() => {
    if (selectedIds.length && selectedIds.some((id) => !currentPage.items.some((item) => item.id === id))) {
      setSelectedIds((current) => current.filter((id) => currentPage.items.some((item) => item.id === id)));
    }
  }, [currentPage, selectedIds]);
  useLayoutEffect(() => {
    if (!pageEl) return;
    const all = [...pageEl.querySelectorAll<HTMLElement>("[data-item-id]")];
    const same = (a: HTMLElement[], b: HTMLElement[]) => a.length === b.length && a.every((el, i) => el === b[i]);
    const selected = all.filter((el) => selectedIds.includes(el.dataset.itemId ?? ""));
    const guides = all.filter((el) => !selectedIds.includes(el.dataset.itemId ?? ""));
    setSelectedElements((previous) => (same(previous, selected) ? previous : selected));
    setGuideElements((previous) => (same(previous, guides) ? previous : guides));
  }, [pageEl, selectedIds, currentPage, activeSheet?.id]);
  useEffect(() => {
    fitZoom();
    // Fit once per sheet, when it is opened; the user's zoom holds after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSheet?.id]);

  const commit = (next: LayoutWorkspace, remember = true) => {
    if (remember) {
      undoRef.current = [
        cloneLayoutWorkspace(workspace),
        ...undoRef.current,
      ].slice(0, 30);
      redoRef.current = [];
    }
    onChange(next);
  };

  const mutate = (change: (draft: LayoutWorkspace) => void) => {
    const next = cloneLayoutWorkspace(workspace);
    change(next);
    commit(next);
  };

  const mutateActiveSheet = (change: (sheet: LayoutSheet) => void) => {
    mutate((draft) => {
      const sheet = draft.sheets.find(({ id }) => id === draft.activeSheetId);
      if (sheet) change(sheet);
    });
  };

  /** Where the next item goes, when the page's menu asked for it at the pointer; consumed by addItem. */
  const placeAtRef = useRef<{ x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const addItem = (
    recipe: LayoutRecipe,
    frame?: { width: number; height: number },
  ) => {
    let createdId = "";
    const at = placeAtRef.current;
    placeAtRef.current = null;
    mutateActiveSheet((sheet) => {
      createdId = crypto.randomUUID();
      const placed = nextLayoutItemPosition(sheet, frame?.width, frame?.height);
      if (at) {
        placed.x = Math.max(0, Math.round(at.x));
        placed.y = Math.max(0, Math.round(at.y));
      }
      sheet.items.push({
        id: createdId,
        ...placed,
        recipe,
      });
    });
    selectItem(createdId);
    scrollItemIntoView(createdId);
  };

  const defaultSource =
    samples.find(({ id }) => id === insertFileId) ?? samples[0] ?? null;
  const mappedActive =
    defaultSource && activePopulationId
      ? resolveFigurePopulation(
          {
            hierarchyId: state.active_hierarchy_id,
            populationId: activePopulationId,
            label: "",
          },
          defaultSource.tree,
          figureHierarchies(state),
        )
      : null;
  const defaultPopulation =
    mappedActive?.id ?? defaultSource?.tree.root_population_id ?? "";

  const addPlot = (kind: "biplot" | "histogram") => {
    if (!defaultSource || !defaultPopulation) {
      setMessage(t("Check an FCS file and select a population first."));
      return;
    }
    addItem({
      kind,
      sampleId: defaultSource.id,
      populationId: defaultPopulation,
      ...(iteration.mode !== "off" ? { iterated: true } : {}),
      xChannel:
        defaultSource.sample.index(defaultX) !== undefined
          ? defaultX
          : (defaultSource.sample.channels[0]?.key ?? ""),
      yChannel:
        kind === "histogram"
          ? null
          : defaultSource.sample.index(defaultY) !== undefined
            ? defaultY
            : (defaultSource.sample.channels[1]?.key ??
              defaultSource.sample.channels[0]?.key ??
              null),
      displayMode: "pseudocolor",
    });
  };

  const addChart = () => {
    if (!defaultSource || !defaultPopulation) {
      setMessage(t("Check an FCS file and select a population first."));
      return;
    }
    addItem(
      {
        kind: "chart",
        sampleId: defaultSource.id,
        populationId: defaultPopulation,
        statistic: "percent_of_parent",
        files: "checked",
        groupBy: metadataColumns[0] ?? "",
        chartType: "bars",
        showPoints: true,
        test: true,
      },
      { width: 320, height: 240 },
    );
  };

  const addText = () => addItem({ kind: "text", text: "Text", fontSize: 18 }, { width: 160, height: 32 });
  const updateRecipeOf = (id: string, change: (recipe: LayoutRecipe) => LayoutRecipe) => {
    mutateActiveSheet((sheet) => {
      const item = sheet.items.find((candidate) => candidate.id === id);
      if (item) item.recipe = change(item.recipe);
    });
  };
  /**
   * A right-click on the page: on an item, a menu of what the inspector offers for it (or for
   * the selection it is part of); on empty page, a menu that adds an item where the pointer is.
   */
  const openCanvasMenu = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-item-id]");
    if (target?.dataset.itemId) {
      const pageId = target.dataset.itemId;
      const item = activeSheet?.items.find(({ id }) => id === templateIdOf(pageId));
      if (!item) return;
      const inSelection = selectedIds.includes(pageId);
      if (!inSelection) selectMany([pageId]);
      const ids = inSelection && selectedTemplateIds.length > 1 ? selectedTemplateIds : [item.id];
      const many = ids.length > 1;
      const plotLike = isPlotLikeRecipe(item.recipe);
      const items: MenuEntry[] = [
        { label: many ? t("Duplicate {n} items", { n: ids.length }) : t("Duplicate"), onClick: () => duplicateItems(ids) },
        { label: t("Bring to front"), onClick: () => restackItems(ids, "front") },
        { label: t("Send to back"), onClick: () => restackItems(ids, "back") },
        { label: item.locked ? t("Unlock") : t("Lock"), onClick: () => setLocked(ids, !item.locked) },
        "separator",
        ...(iteration.mode !== "off" && plotLike
          ? [
              {
                label: "iterated" in item.recipe && item.recipe.iterated ? t("Stop following the iteration") : t("Follow the iteration"),
                onClick: () => updateRecipeOf(item.id, (recipe) => (isPlotLikeRecipe(recipe) ? { ...recipe, iterated: !recipe.iterated } : recipe)),
              } satisfies MenuEntry,
              "separator" as const,
            ]
          : []),
        ...(plotLike ? [{ label: t("Open in Gating"), onClick: () => onOpenInGating(item.recipe as LayoutPlotRecipe | LayoutStrategyRecipe) } satisfies MenuEntry] : []),
        ...(item.recipe.kind === "figure" && onOpenInIllustration
          ? [{ label: t("Edit in Illustration"), onClick: () => onOpenInIllustration(structuredClone((item.recipe as LayoutFigureRecipe).illustration)) } satisfies MenuEntry]
          : []),
        ...(item.recipe.kind === "proportions" && onOpenInPlotting
          ? [{ label: t("Edit in Plotting"), onClick: () => onOpenInPlotting(structuredClone((item.recipe as LayoutProportionsRecipe).settings)) } satisfies MenuEntry]
          : []),
        { label: many ? t("Remove {n} items", { n: ids.length }) : t("Remove"), onClick: () => removeItems(ids) },
      ];
      setContextMenu({ x: event.clientX, y: event.clientY, items, label: itemTitle(item, samples, state) });
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const at = { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom };
    const here = (add: () => void) => () => {
      placeAtRef.current = at;
      add();
    };
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      label: t("Page"),
      items: [
        { label: t("+ Biplot"), disabled: !ready, onClick: here(() => addPlot("biplot")) },
        { label: t("+ Histogram"), disabled: !ready, onClick: here(() => addPlot("histogram")) },
        { label: t("+ Gating strategy"), disabled: !ready, onClick: here(addStrategy) },
        { label: t("+ Chart"), disabled: !ready, onClick: here(addChart) },
        { label: t("+ Text"), onClick: here(addText) },
        { label: t("+ Illustration figure"), disabled: !ready || !illustrationConfig?.figure, onClick: here(addFigureBlock) },
        { label: t("+ Plotting chart"), disabled: !ready || !plottingSettings, onClick: here(addProportionsBlock) },
        "separator",
        { label: t("Select all"), disabled: !currentPage.items.length, onClick: () => selectMany(currentPage.items.map(({ id }) => id)) },
      ],
    });
  };

  /** The Illustration tab's current figure as one block, drawn as it is there. */
  const addFigureBlock = () => {
    if (!illustrationConfig?.figure) {
      setMessage(t("Make a figure on the Illustration tab first."));
      return;
    }
    if (!activeSheet) return;
    addItem({ kind: "figure", illustration: structuredClone(illustrationConfig), page: 0 }, figureBlockFrame(illustrationConfig, files, state, activeSheet));
  };

  /** The Plotting tab's current chart as one block, drawn as it is there. */
  const addProportionsBlock = () => {
    if (!plottingSettings || !activeSheet) return;
    const settings = plottingSettings();
    const model = buildProportionsModel(settings, proportionsSampleRefs(files), state, metadataById, divisionProfiles);
    if (!model.catLevels.length || !model.perSample.length) {
      setMessage(t("Choose files and populations on the Plotting tab first."));
      return;
    }
    addItem({ kind: "proportions", settings }, proportionsBlockFrame(settings, model, activeSheet));
  };

  const addStrategy = () => {
    if (!defaultSource || !defaultPopulation) {
      setMessage(t("Check an FCS file and select a population first."));
      return;
    }
    // A strategy of the root has no steps. When nothing deeper is active, take the file's last
    // population in tree order, so the block shows a strategy rather than an empty message.
    const rootId = defaultSource.tree.root_population_id ?? "";
    const populationId = defaultPopulation !== rootId
      ? defaultPopulation
      : (populationTreeOrder(defaultSource.tree.populations, rootId)
          .filter(({ popId }) => popId !== rootId)
          .at(-1)?.popId ?? defaultPopulation);
    addItem(
      {
        kind: "strategy",
        sampleId: defaultSource.id,
        populationId,
        fullPath: true,
        displayMode: "pseudocolor",
        ...(iteration.mode !== "off" ? { iterated: true } : {}),
      },
      { width: 600, height: 320 },
    );
  };

  const addIllustrationSelection = () => {
    if (!illustrationConfig) {
      setMessage(t("Render or configure an Illustration selection first."));
      return;
    }
    if (
      !illustrationConfig.figure &&
      illustrationConfig.plotType === "heatmap"
    ) {
      setMessage(
        t("Heatmap layout blocks are planned for the next Layout phase."),
      );
      return;
    }
    const sourceById = new Map(samples.map((sample) => [sample.id, sample]));
    const combinations: {
      sampleId: string;
      populationId: string;
      xChannel: string;
      yChannel?: string;
      type?: "biplot" | "histogram";
    }[] = [];
    const figure = illustrationConfig.figure;
    for (const source of samples) {
      if (figure) {
        if (!figure.sampleIds.includes(source.id)) continue;
        for (const plot of figure.plots) {
          if (plot.type === "heatmap") continue;
          for (const ref of plot.population
            ? [plot.population]
            : (figure.samplePopulations?.[source.id] ?? figure.populations)) {
            const mapped = resolveFigurePopulation(
              ref,
              source.tree,
              figureHierarchies(state),
            );
            if (mapped.id && mapped.status !== "changed")
              combinations.push({
                sampleId: source.id,
                populationId: mapped.id,
                xChannel: plot.x,
                yChannel: plot.y,
                type: plot.type,
              });
          }
        }
        continue;
      }
      const popIds =
        illustrationConfig.selectionMode === "matrix"
          ? (illustrationConfig.selectedPopulationsBySample?.[source.id] ?? [])
          : illustrationConfig.popIds;
      for (const populationId of popIds) {
        for (const xChannel of illustrationConfig.xChannels) {
          combinations.push({ sampleId: source.id, populationId, xChannel });
        }
      }
    }
    const accepted = combinations.slice(0, 60);
    if (accepted.length === 0) {
      setMessage(
        t("The current Illustration selection has no plot combinations."),
      );
      return;
    }
    mutateActiveSheet((sheet) => {
      for (const combination of accepted) {
        const source = sourceById.get(combination.sampleId);
        if (!source) continue;
        const kind =
          combination.type ??
          (illustrationConfig.plotType === "histogram"
            ? "histogram"
            : "biplot");
        sheet.items.push({
          id: crypto.randomUUID(),
          ...nextLayoutItemPosition(sheet),
          recipe: {
            kind,
            sampleId: combination.sampleId,
            populationId: combination.populationId,
            xChannel: combination.xChannel,
            yChannel:
              kind === "histogram"
                ? null
                : (combination.yChannel ?? illustrationConfig.yChannel),
            displayMode: (illustrationConfig.displayMode === "dots"
              ? "scatter"
              : illustrationConfig.displayMode) as LayoutDisplayMode,
          },
        });
      }
    });
    setMessage(
      combinations.length > accepted.length
        ? t(
            "Added the first {count} Illustration plots; refine the selection before adding more.",
            {
              count: accepted.length,
            },
          )
        : t("Added {count} Illustration plots.", { count: accepted.length }),
    );
  };

  const updateSelectedRecipe = (
    change: (recipe: LayoutRecipe) => LayoutRecipe,
  ) => {
    if (!selectedItem) return;
    mutateActiveSheet((sheet) => {
      const item = sheet.items.find(({ id }) => id === selectedItem.id);
      if (item) item.recipe = change(item.recipe);
    });
  };

  const removeItems = (ids: readonly string[]) => {
    mutateActiveSheet((sheet) => {
      sheet.items = sheet.items.filter((item) => !ids.includes(item.id));
    });
    setSelectedIds((current) => current.filter((id) => !ids.includes(id)));
  };
  /** Copies 20 px down and right, or at the frames given (an Option-drag), on top of the stack. */
  const duplicateItems = (ids: readonly string[], frames?: Record<string, { x: number; y: number; width: number; height: number }>) => {
    const created: string[] = [];
    mutateActiveSheet((sheet) => {
      let z = Math.max(0, ...sheet.items.map((item) => item.z));
      for (const id of ids) {
        const source = sheet.items.find((item) => item.id === id);
        if (!source) continue;
        const copyId = crypto.randomUUID();
        created.push(copyId);
        const frame = frames?.[id] ?? { x: source.x + 20, y: source.y + 20, width: source.width, height: source.height };
        sheet.items.push({ ...source, ...frame, id: copyId, locked: false, z: ++z, recipe: { ...source.recipe } });
      }
    });
    if (created.length) selectMany(created);
    return created;
  };
  const nudgeItems = (ids: readonly string[], dx: number, dy: number) => {
    mutateActiveSheet((sheet) => {
      for (const item of sheet.items) {
        if (!ids.includes(item.id) || item.locked) continue;
        item.x = Math.max(0, item.x + dx);
        item.y = Math.max(0, item.y + dy);
      }
    });
  };
  /** Move items to the top or the bottom of the stack; z is then the stacking order 0…n−1. */
  const restackItems = (ids: readonly string[], where: "front" | "back") => {
    mutateActiveSheet((sheet) => {
      const ordered = [...sheet.items].sort((a, b) => a.z - b.z);
      const moving = ordered.filter((item) => ids.includes(item.id));
      const rest = ordered.filter((item) => !ids.includes(item.id));
      const next = where === "front" ? [...rest, ...moving] : [...moving, ...rest];
      next.forEach((entry, z) => {
        entry.z = z;
      });
    });
  };
  const setLocked = (ids: readonly string[], locked: boolean) => {
    mutateActiveSheet((sheet) => {
      for (const item of sheet.items) if (ids.includes(item.id)) item.locked = locked;
    });
  };
  const arrange = (how: AlignHow) => {
    mutateActiveSheet((sheet) => alignItems(sheet, selectedTemplateIds.filter((id) => !sheet.items.find((item) => item.id === id)?.locked), how));
  };
  const spread = (how: DistributeHow) => {
    mutateActiveSheet((sheet) => distributeItems(sheet, selectedTemplateIds, how));
  };
  /** What Moveable moved or resized becomes the items' frames; an Option-drag leaves the originals and makes copies there. */
  const commitFrames = (targets: readonly Element[], asCopies: boolean) => {
    const frames: Record<string, { x: number; y: number; width: number; height: number }> = {};
    for (const el of targets) {
      const pageId = (el as HTMLElement).dataset.itemId;
      const pageItem = currentPage.items.find((candidate) => candidate.id === pageId);
      if (!pageItem) continue;
      // A moved tile copy is mapped back to the template through its tile's offset.
      const { id, ...frame } = templateFrame(pageItem, frameOfElement(el as HTMLElement));
      frames[id] = frame;
    }
    const ids = Object.keys(frames);
    if (!ids.length) return;
    if (asCopies) {
      // The originals' elements were dragged; put them back where their items are, since React
      // will not touch a style it believes unchanged.
      for (const el of targets) {
        const item = currentPage.items.find((candidate) => candidate.id === (el as HTMLElement).dataset.itemId);
        if (item) Object.assign((el as HTMLElement).style, { left: `${item.x}px`, top: `${item.y}px`, width: `${item.width}px`, height: `${item.height}px` });
      }
      duplicateItems(ids, frames);
      return;
    }
    mutateActiveSheet((sheet) => {
      for (const item of sheet.items) if (frames[item.id]) Object.assign(item, frames[item.id]);
    });
  };
  /**
   * An Option-drag copies: the dragged element is the original, so a ghost of it is left where
   * it stood until the drop, and the original goes back there when the copy is made. A ghost is
   * a clone with its canvases repainted, since a cloned canvas is blank.
   */
  const leaveGhosts = (targets: readonly (HTMLElement | SVGElement)[]): HTMLElement[] =>
    targets.flatMap((target) => {
      if (!(target instanceof HTMLElement) || !target.parentElement) return [];
      const ghost = target.cloneNode(true) as HTMLElement;
      ghost.classList.add("gl-layout-ghost");
      ghost.classList.remove("is-selected");
      ghost.removeAttribute("data-item-id");
      ghost.setAttribute("aria-hidden", "true");
      const originals = target.querySelectorAll("canvas");
      ghost.querySelectorAll("canvas").forEach((canvas, index) => {
        const original = originals[index];
        if (!original) return;
        canvas.width = original.width;
        canvas.height = original.height;
        canvas.getContext("2d")?.drawImage(original, 0, 0);
      });
      target.parentElement.insertBefore(ghost, target);
      return [ghost];
    });
  const removeGhosts = (ghosts: unknown) => {
    if (Array.isArray(ghosts)) for (const ghost of ghosts) (ghost as HTMLElement).remove();
  };
  const applyDrag = (e: OnDrag) => {
    e.target.style.left = `${e.left}px`;
    e.target.style.top = `${e.top}px`;
  };
  const applyResize = (e: OnResize) => {
    e.target.style.width = `${e.width}px`;
    e.target.style.height = `${e.height}px`;
    e.target.style.left = `${e.drag.left}px`;
    e.target.style.top = `${e.drag.top}px`;
  };
  /**
   * A drag that starts inside the selection belongs to Moveable, not to the marquee. A single
   * item drags itself; a group's overlay lets presses through (so editors can take focus), so
   * a press on a member starts the group drag here.
   */
  const onSelectoDragStart = (e: OnSelectoDragStart) => {
    const target = e.inputEvent?.target as Element | undefined;
    if (!target) return;
    const moveable = moveableRef.current;
    if (moveable?.isMoveableElement(target)) {
      e.stop();
      return;
    }
    if (selectedElements.some((el) => el === target || el.contains(target))) {
      e.stop();
      if (selectedElements.length > 1) moveable?.dragStart(e.inputEvent);
    }
  };
  const onSelectEnd = (e: OnSelectEnd) => {
    const ids = e.selected.map((el) => (el as HTMLElement).dataset.itemId ?? "").filter(Boolean);
    selectMany(ids);
    if (e.isDragStart) {
      // Pressing an unselected item and moving at once selects it and drags it.
      e.inputEvent?.preventDefault?.();
      void moveableRef.current?.waitToChangeTarget().then(() => moveableRef.current?.dragStart(e.inputEvent));
    }
  };
  const scrollItemIntoView = (id: string) => {
    window.requestAnimationFrame(() => {
      pageRef.current?.querySelector<HTMLElement>(`[data-item-id="${id}"]`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    });
  };
  const setPage = (page: LayoutPage) => {
    mutateActiveSheet((sheet) => applyLayoutPage(sheet, page));
  };
  const pageToContent = () => mutateActiveSheet((sheet) => fitPageToContent(sheet));
  const contentToPage = () => mutateActiveSheet((sheet) => fitContentToPage(sheet));
  /** Snap lines of the page grid: every page's edges, margins and centre lines. */
  const pageGuides = (() => {
    const vertical: number[] = [], horizontal: number[] = [];
    if (!activeSheet) return { vertical, horizontal };
    const one = pageSizePx(activeSheet.page);
    const margin = mmToPx(activeSheet.page.marginMm);
    for (const origin of pageOrigins(activeSheet.page)) {
      vertical.push(origin.x, origin.x + margin, origin.x + one.width / 2, origin.x + one.width - margin, origin.x + one.width);
      horizontal.push(origin.y, origin.y + margin, origin.y + one.height / 2, origin.y + one.height - margin, origin.y + one.height);
    }
    return { vertical: [...new Set(vertical)], horizontal: [...new Set(horizontal)] };
  })();
  /** The zoom at which the whole page is in view; nothing changes where the pane has no size. */
  const fitZoom = () => {
    const scroller = canvasRef.current;
    if (!scroller || !activeSheet) return;
    const available = { width: scroller.clientWidth - 36, height: scroller.clientHeight - 36 };
    if (available.width <= 0 || available.height <= 0) return;
    const next = Math.min(available.width / activeSheet.width, available.height / activeSheet.height);
    setZoom(Math.max(0.1, Math.min(4, Math.floor(next * 100) / 100)));
  };
  // Option-scroll, Shift-scroll or a trackpad pinch (Ctrl-wheel) zooms about the pointer: the
  // page point under it stays put. A plain scroll still scrolls. The listener is the DOM's, not
  // React's, because React's wheel listeners are passive and cannot cancel the scroll.
  useEffect(() => {
    const scroller = canvasEl;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.altKey || event.shiftKey || event.ctrlKey)) return;
      const delta = event.deltaY || event.deltaX;
      if (!delta) return;
      event.preventDefault();
      const current = zoomRef.current;
      const next = Math.max(0.1, Math.min(4, Math.round(current * Math.exp(-delta * 0.0025) * 100) / 100));
      if (next === current) return;
      zoomRef.current = next;
      setZoom(next);
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
  }, [canvasEl]);
  const stepZoom = (direction: 1 | -1) => {
    const next = direction > 0
      ? ZOOM_STEPS.find((step) => step > zoom + 0.001)
      : [...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001);
    if (next) setZoom(next);
  };
  /** The plots of a page draw shortly after it is shown; the export waits for them. */
  const settleRender = () =>
    new Promise<void>((resolve) => {
      window.setTimeout(() => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())), 450);
    });
  const exportSheet = async () => {
    const canvas = pageRef.current;
    if (!canvas || !activeSheet || exporting) return;
    setExporting(true);
    const shownPage = currentPageIndex;
    try {
      const composed: ComposedPage[] = [];
      for (let index = 0; index < pages.length; index++) {
        if (pages.length > 1) {
          setPageIndex(index);
          await settleRender();
        }
        composed.push(...composeSheetPages(canvas, activeSheet, { zoom }));
      }
      await writeComposedPages(composed, activeSheet, exportFormat);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (pages.length > 1) setPageIndex(shownPage);
      setExporting(false);
    }
  };
  const setIteration = (next: LayoutIteration) => {
    mutateActiveSheet((sheet) => {
      if (next.mode === "off") {
        delete sheet.iteration;
        return;
      }
      // Switched on with nothing following it, the iteration would repeat every plot unchanged
      // on every page, so the plots follow it unless one already does.
      if ((sheet.iteration?.mode ?? "off") === "off" && !sheet.items.some(followsIteration)) {
        for (const item of sheet.items) if (isPlotLikeRecipe(item.recipe)) item.recipe.iterated = true;
      }
      sheet.iteration = next;
    });
    setPageIndex(0);
  };
  /** The values a metadata column takes across the files, for the iteration's source. */
  const metadataValues = (column: string) => [...new Set(files.map((file) => file.metadata?.[column] ?? "").filter(Boolean))];
  const sourceKey = iteration.source.kind === "group"
    ? `group:${iteration.source.groupId}`
    : iteration.source.kind === "metadata"
      ? `meta:${iteration.source.column}=${iteration.source.value}`
      : iteration.source.kind;
  const sourceFromKey = (key: string): LayoutIteration["source"] => {
    if (key === "all") return { kind: "all" };
    if (key.startsWith("group:")) return { kind: "group", groupId: key.slice(6) };
    if (key.startsWith("meta:")) {
      const [column, ...rest] = key.slice(5).split("=");
      return { kind: "metadata", column, value: rest.join("=") };
    }
    return { kind: "checked" };
  };
  const onCanvasKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const history = historyShortcutAction(event.nativeEvent);
    if (history) {
      event.preventDefault();
      if (history === "undo") undo();
      else redo();
      return;
    }
    if ((event.target as HTMLElement).closest("input, textarea, select")) return;
    const meta = event.metaKey || event.ctrlKey;
    if (event.key === "Escape") {
      setSelectedIds([]);
      return;
    }
    if (meta && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectMany((activeSheet?.items ?? []).filter((item) => !item.locked).map((item) => item.id));
      return;
    }
    if (!selectedIds.length) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      removeItems(selectedTemplateIds);
      return;
    }
    if (meta && event.key.toLowerCase() === "d") {
      event.preventDefault();
      duplicateItems(selectedTemplateIds);
      return;
    }
    const step = event.shiftKey ? 10 : 1;
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = arrows[event.key];
    if (delta) {
      event.preventDefault();
      nudgeItems(selectedTemplateIds, delta[0], delta[1]);
    }
  };

  const selectedRecipe = selectedItem?.recipe;
  const selectedSource =
    selectedRecipe && "sampleId" in selectedRecipe
      ? (samples.find(({ id }) => id === selectedRecipe.sampleId) ?? null)
      : null;
  /** The selected item's file's channels, by key and display label, for the axis pickers. */
  const layoutChannelOptions = selectedSource
    ? selectedSource.sample.channels.map((channel) => ({
        value: channel.key,
        label: selectedSource.sample.channelLabel(selectedSource.sample.index(channel.key) ?? 0),
      }))
    : [];
  const selectedPopulations = selectedSource
    ? populationTreeOrder(
        selectedSource.tree.populations,
        selectedSource.tree.root_population_id ?? "",
      )
    : [];

  const undo = () => {
    const previous = undoRef.current.shift();
    if (!previous) return;
    redoRef.current = [
      cloneLayoutWorkspace(workspace),
      ...redoRef.current,
    ].slice(0, 30);
    commit(previous, false);
  };
  const redo = () => {
    const next = redoRef.current.shift();
    if (!next) return;
    undoRef.current = [
      cloneLayoutWorkspace(workspace),
      ...undoRef.current,
    ].slice(0, 30);
    commit(next, false);
  };

  if (!activeSheet) return null;

  return (
    <div
      className={`gl-tab-panel gl-tab-fill gl-layout-tab${preview ? " is-preview" : ""}`}
    >
      <div
        className="gl-layout-sheet-tabs"
        role="tablist"
        aria-label={t("Layout sheets")}
      >
        {workspace.sheets.map((sheet) => (
          <div key={sheet.id} className="gl-layout-sheet-tab-wrap">
            {renamingSheetId === sheet.id ? (
              <input
                className="gl-layout-sheet-rename"
                defaultValue={sheet.name}
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
                onBlur={(event) => {
                  const name = event.currentTarget.value.trim();
                  if (name) {
                    mutate((draft) => {
                      const target = draft.sheets.find(
                        ({ id }) => id === sheet.id,
                      );
                      if (target) target.name = name;
                    });
                  }
                  setRenamingSheetId(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") setRenamingSheetId(null);
                }}
              />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={workspace.activeSheetId === sheet.id}
                className={`gl-layout-sheet-tab${workspace.activeSheetId === sheet.id ? " active" : ""}`}
                title={t("Double-click to rename")}
                onClick={() =>
                  mutate((draft) => {
                    draft.activeSheetId = sheet.id;
                  })
                }
                onDoubleClick={() => setRenamingSheetId(sheet.id)}
              >
                {sheet.name}
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          className="gl-layout-sheet-add"
          title={t("New blank layout")}
          onClick={() => {
            const next = createLayoutSheet(
              `Layout ${workspace.sheets.length + 1}`,
              { ...activeSheet.page },
            );
            mutate((draft) => {
              draft.sheets.push(next);
              draft.activeSheetId = next.id;
            });
            setSelectedIds([]);
          }}
        >
          +
        </button>
      </div>

      <div
        className="gl-layout-toolbar"
        onMouseDown={(event) => {
          // A toolbar click does not take the keyboard from the page, so Escape, Delete and the
          // arrows still act on the selection afterwards.
          if ((event.target as HTMLElement).closest("button") && selectedIds.length) event.preventDefault();
        }}
      >
        <div className="gl-layout-toolbar-group">
          <button className="gl-mini-btn" type="button" onClick={() => addPlot("biplot")} disabled={!ready} title={ready ? t("Add a plot of one population on two channels of the chosen file") : t("Preparing the files…")}>
            {t("+ Biplot")}
          </button>
          <button className="gl-mini-btn" type="button" onClick={() => addPlot("histogram")} disabled={!ready} title={ready ? t("Add a histogram of one population on one channel of the chosen file") : t("Preparing the files…")}>
            {t("+ Histogram")}
          </button>
          <button className="gl-mini-btn" type="button" onClick={addStrategy} disabled={!ready} title={ready ? t("Add the gating steps that lead to a population, as a strip of plots") : t("Preparing the files…")}>
            {t("+ Gating strategy")}
          </button>
          <button className="gl-mini-btn" type="button" onClick={addChart} disabled={!ready} title={ready ? t("Add a summary chart: one statistic of a population per file, grouped by a metadata column, with a test between the groups") : t("Preparing the files…")}>
            {t("+ Chart")}
          </button>
          <button
            className="gl-mini-btn"
            type="button"
            title={t("Add a text block; edit it on the page")}
            onClick={addText}
          >
            {t("+ Text")}
          </button>
          <button className="gl-mini-btn" type="button" onClick={addIllustrationSelection} disabled={!ready} title={t("Add one plot per file and plot of the Illustration tab's current selection")}>
            {t("Add Illustration selection")}
          </button>
          <button className="gl-mini-btn" type="button" onClick={addFigureBlock} disabled={!ready} title={t("Add the Illustration tab's current figure as one block, drawn here as it is there")}>
            {t("+ Illustration figure")}
          </button>
          <button className="gl-mini-btn" type="button" onClick={addProportionsBlock} disabled={!ready || !plottingSettings} title={t("Add the Plotting tab's current chart as one block, drawn here as it is there")}>
            {t("+ Plotting chart")}
          </button>
        </div>
        <div className="gl-layout-toolbar-group gl-layout-arrange" role="group" aria-label={t("Arrange")}>
          {ALIGNMENTS.map(({ how, label, title }) => (
            <button key={how} className="gl-mini-btn" type="button" onClick={() => arrange(how)} disabled={!selectedIds.length || preview} title={t(title)}>{t(label)}</button>
          ))}
          {DISTRIBUTIONS.map(({ how, label, title }) => (
            <button key={how} className="gl-mini-btn" type="button" onClick={() => spread(how)} disabled={selectedIds.length < 3 || preview} title={t(title)}>{t(label)}</button>
          ))}
          <button className="gl-mini-btn" type="button" aria-pressed={snapToGrid} onClick={() => setSnapToGrid((was) => !was)} title={t("Snap moves and resizes to a 10 px grid; edges and centres of other items and the page snap always")}>
            {t("Snap grid")}
          </button>
        </div>
        <div className="gl-layout-toolbar-group">
          <button className="gl-mini-btn" type="button" aria-pressed={preview} onClick={() => setPreview(!preview)} title={t("Show the page as it exports, without grid, margins or handles")}>
            {preview ? t("Edit layout") : t("Preview")}
          </button>
          <button className="gl-mini-btn" type="button" disabled={!undoRef.current.length} onClick={undo} title={t("Undo the last layout edit (Cmd-Z)")}>
            {t("Undo")}
          </button>
          <button className="gl-mini-btn" type="button" disabled={!redoRef.current.length} onClick={redo} title={t("Redo the undone edit (Shift-Cmd-Z)")}>
            {t("Redo")}
          </button>
          <button
            className="gl-mini-btn"
            type="button"
            title={t("Copy this sheet, with its page and items, as a new sheet")}
            onClick={() => {
              const copy = {
                ...activeSheet,
                id: crypto.randomUUID(),
                page: { ...activeSheet.page },
                name: `${activeSheet.name} copy`,
                items: activeSheet.items.map((item) => ({
                  ...item,
                  id: crypto.randomUUID(),
                  recipe: { ...item.recipe },
                })),
              };
              mutate((draft) => {
                draft.sheets.push(copy);
                draft.activeSheetId = copy.id;
              });
              setSelectedIds([]);
            }}
          >
            {t("Duplicate sheet")}
          </button>
          <button
            className="gl-mini-btn"
            type="button"
            disabled={workspace.sheets.length <= 1}
            title={t("Remove this sheet; the layout keeps at least one")}
            onClick={() => {
              mutate((draft) => {
                const index = draft.sheets.findIndex(
                  ({ id }) => id === draft.activeSheetId,
                );
                draft.sheets.splice(index, 1);
                draft.activeSheetId = draft.sheets[Math.max(0, index - 1)].id;
              });
              setSelectedIds([]);
            }}
          >
            {t("Delete sheet")}
          </button>
        </div>
        <div className="gl-layout-toolbar-group gl-layout-zoom-controls" role="group" aria-label={t("Zoom")}>
          <button className="gl-mini-btn" type="button" onClick={fitZoom} title={t("Fit the page to the window")}>{t("Fit")}</button>
          <button className="gl-mini-btn" type="button" onClick={() => stepZoom(-1)} aria-label={t("Zoom out")} title={t("Zoom out")} disabled={zoom <= ZOOM_STEPS[0]}>−</button>
          <span className="gl-layout-zoom-level" aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button className="gl-mini-btn" type="button" onClick={() => stepZoom(1)} aria-label={t("Zoom in")} title={t("Zoom in")} disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}>+</button>
        </div>
        {(pages.length > 1 || iteration.mode !== "off") && (
          <div className="gl-layout-toolbar-group gl-layout-pages" role="group" aria-label={t("Pages of the iteration")}>
            <button className="gl-mini-btn" type="button" onClick={() => setPageIndex(Math.max(0, currentPageIndex - 1))} disabled={currentPageIndex === 0} aria-label={t("Previous page")} title={t("Previous page")}>◀</button>
            <span className="gl-layout-page-label" aria-live="polite">
              {t("Page {n} of {count}", { n: currentPageIndex + 1, count: Math.max(1, pages.length) })}
              {currentPage.units.length > 0 && ` · ${currentPage.units.map((unit) => unit.name).join(", ")}`}
            </span>
            <button className="gl-mini-btn" type="button" onClick={() => setPageIndex(Math.min(pages.length - 1, currentPageIndex + 1))} disabled={currentPageIndex >= pages.length - 1} aria-label={t("Next page")} title={t("Next page")}>▶</button>
          </div>
        )}
        <div className="gl-layout-toolbar-group">
          <button className="gl-mini-btn" type="button" onClick={() => void exportSheet()} disabled={exporting || !activeSheet.items.length} title={pages.length > 1 ? t("Write every page of the iteration; the format is chosen under Page") : t("Write this sheet at its page size; the format is chosen under Page")}>
            {exporting ? t("Exporting…") : t("Export {format}", { format: exportFormat.toUpperCase() })}
          </button>
        </div>
        <span className="gl-layout-performance-note">
          {t("Plots follow the Gating tab's axes and gates; edit gates there.")}
        </span>
      </div>

      {message && (
        <div className="gl-layout-message" role="status">
          <span>{message}</span>
          <button type="button" title={t("Dismiss")} aria-label={t("Dismiss")} onClick={() => setMessage(null)}>
            ×
          </button>
        </div>
      )}

      <div className="gl-layout-workspace">
        <aside className="gl-layout-controls" aria-label="Layout controls">
          <nav className="gl-presentation-tabs" aria-label="Layout inspector">
            {(["item", "page", "iterate", "style"] as const).map((tab) => (
              <button
                key={tab}
                aria-pressed={section === tab}
                title={tab === "item" ? t("The selected item, or the file new plots take") : tab === "page" ? t("Page size, margins, pages and export") : tab === "iterate" ? t("Draw the sheet once per file: which files, and pages or tiles") : t("How the sheet's plots are drawn: points, contours, histograms, gates and fonts")}
                onClick={() => setSection(tab)}
              >
                {tab === "item" ? t("Items") : tab === "page" ? t("Page") : tab === "iterate" ? t("Iterate") : t("Style")}
              </button>
            ))}
          </nav>
          {section === "item" && (
            <>
              <label className="gl-field-inline">
                File for new plots
                <select
                  value={insertFileId}
                  onChange={(event) => setInsertFileId(event.target.value)}
                >
                  {files.map((file) => (
                    <option key={file.id} value={file.id}>
                      {file.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="gl-hint">
                Placed plots keep their own file and hierarchy, independently of
                the Gating selection.
              </p>
              {sourceResult.error && <p role="alert">{sourceResult.error}</p>}
              {selectedItems.length > 1 && (
                <div className="gl-layout-inspector" aria-label={t("Selected layout items")}>
                  <strong>{t("{count} items selected", { count: selectedItems.length })}</strong>
                  <div className="gl-layout-item-actions">
                    <button type="button" className="gl-mini-btn" onClick={() => duplicateItems(selectedIds)} title={t("Copies of every selected item, 20 px down and right (Cmd-D)")}>{t("Duplicate")}</button>
                    <button type="button" className="gl-mini-btn" onClick={() => restackItems(selectedIds, "front")} title={t("Draw the selected items over every other")}>{t("Bring to front")}</button>
                    <button type="button" className="gl-mini-btn" onClick={() => restackItems(selectedIds, "back")} title={t("Draw the selected items under every other")}>{t("Send to back")}</button>
                    <button type="button" className="gl-mini-btn" onClick={() => setLocked(selectedIds, !selectionLocked)} title={t("Lock or unlock the selected items")}>{selectionLocked ? t("Unlock") : t("Lock")}</button>
                    <button type="button" className="gl-mini-btn" onClick={() => removeItems(selectedIds)} title={t("Remove the selected items (Delete)")}>{t("Remove")}</button>
                  </div>
                  <p className="gl-hint">{t("Align and spread them with the toolbar; drag any of them to move them together.")}</p>
                </div>
              )}
              {!selectedItems.length && (
                <p className="gl-hint">
                  {t("Click an item to select it, drag empty page to select several, Shift-click to add. Drag to move; drag a corner handle or an edge to resize; Option-drag to copy. Delete removes, arrows nudge (Shift: 10 px), Cmd-D duplicates, Cmd-A selects all, Cmd-Z undoes.")}
                </p>
              )}
              {selectedItem && (
                <div
                  className="gl-layout-inspector"
                  aria-label={t("Selected layout item")}
                >
                  <strong>{t("Selected")}</strong>
                  <label className="gl-check">
                    <input
                      type="checkbox"
                      checked={selectedItem.showFrame === true}
                      onChange={(event) =>
                        mutateActiveSheet((sheet) => {
                          const item = sheet.items.find(
                            (item) => item.id === selectedItem.id,
                          );
                          if (item) item.showFrame = event.target.checked;
                        })
                      }
                    />
                    Surrounding frame
                  </label>
                  <div className="gl-layout-item-actions">
                    <button type="button" className="gl-mini-btn" onClick={() => duplicateItems([selectedItem.id])} title={t("A copy 20 px down and right (Cmd-D); Option-drag an item to copy it where you drop it")}>{t("Duplicate")}</button>
                    <button type="button" className="gl-mini-btn" onClick={() => restackItems([selectedItem.id], "front")} title={t("Draw this item over every other")}>{t("Bring to front")}</button>
                    <button type="button" className="gl-mini-btn" onClick={() => restackItems([selectedItem.id], "back")} title={t("Draw this item under every other")}>{t("Send to back")}</button>
                    <button type="button" className="gl-mini-btn" onClick={() => removeItems([selectedItem.id])} title={t("Remove this item from the page (Delete)")}>{t("Remove")}</button>
                  </div>
                  <label className="gl-check" title={t("A locked item keeps its place and size; it can still be selected to unlock it")}>
                    <input
                      type="checkbox"
                      checked={selectedItem.locked === true}
                      onChange={(event) => setLocked([selectedItem.id], event.target.checked)}
                    />
                    {t("Locked")}
                  </label>
                  <div className="gl-layout-dimensions">
                    {(["x", "y", "width", "height"] as const).map((field) => (
                      <label key={field}>
                        {DIMENSION_LABELS[field]}
                        <NumberField
                          aria-label={`Item ${field}`}
                          min={
                            field === "width" || field === "height"
                              ? layoutItemMinimum(selectedItem.recipe.kind)[
                                  field
                                ]
                              : 0
                          }
                          integer
                          value={selectedItem[field]}
                          onCommit={(value) =>
                            mutateActiveSheet((sheet) => {
                              const item = sheet.items.find(
                                (item) => item.id === selectedItem.id,
                              );
                              if (item) item[field] = value;
                            })
                          }
                        />
                      </label>
                    ))}
                  </div>
                  {selectedItem.recipe.kind === "text" ? (
                    <>
                      <label className="gl-field-inline">
                        {t("Text")}
                        <input
                          value={selectedItem.recipe.text}
                          onChange={(event) =>
                            updateSelectedRecipe((recipe) =>
                              recipe.kind === "text"
                                ? { ...recipe, text: event.target.value }
                                : recipe,
                            )
                          }
                        />
                      </label>
                      <label className="gl-field-inline">
                        {t("Reads from")}
                        <select
                          aria-label={t("Reads from")}
                          value={selectedItem.recipe.readsFrom ?? ""}
                          onChange={(event) =>
                            updateSelectedRecipe((recipe) => {
                              if (recipe.kind !== "text") return recipe;
                              const next = { ...recipe };
                              if (event.target.value) next.readsFrom = event.target.value;
                              else delete next.readsFrom;
                              return next;
                            })
                          }
                        >
                          <option value="">{t("Nothing: plain text")}</option>
                          {activeSheet.items.filter((candidate) => isPlotLikeRecipe(candidate.recipe)).map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>{itemTitle(candidate, samples, state)}</option>
                          ))}
                        </select>
                      </label>
                      {selectedItem.recipe.readsFrom && (
                        <p className="gl-hint">{t("The placeholders read that plot: {list}. On an iterated sheet they follow it from tile to tile.", { list: TITLE_PLACEHOLDERS })}</p>
                      )}
                      <label className="gl-field-inline">
                        {t("Font")}
                        <NumberField
                          min={8}
                          max={72}
                          integer
                          value={selectedItem.recipe.fontSize}
                          onCommit={(fontSize) =>
                            updateSelectedRecipe((recipe) =>
                              recipe.kind === "text" ? { ...recipe, fontSize } : recipe,
                            )
                          }
                        />
                      </label>
                      <label className="gl-check">
                        <input
                          type="checkbox"
                          checked={selectedItem.recipe.bold === true}
                          onChange={(event) =>
                            updateSelectedRecipe((recipe) => {
                              if (recipe.kind !== "text") return recipe;
                              const next = { ...recipe };
                              if (event.target.checked) next.bold = true;
                              else delete next.bold;
                              return next;
                            })
                          }
                        />
                        {t("Bold")}
                      </label>
                    </>
                  ) : selectedItem.recipe.kind === "figure" ? (
                    <>
                      <p className="gl-hint">
                        {t("An Illustration figure, drawn here as it is there. To change it, edit it on the Illustration tab and put it back with the button below.")}
                      </p>
                      <label className="gl-field-inline">
                        {t("Figure page")}
                        <NumberField
                          aria-label={t("Figure page")}
                          value={selectedItem.recipe.page + 1}
                          min={1}
                          integer
                          onCommit={(value) => updateSelectedRecipe((recipe) => (recipe.kind === "figure" ? { ...recipe, page: Math.max(0, value - 1) } : recipe))}
                        />
                      </label>
                      <label className="gl-field-inline gl-layout-title-field">
                        {t("Title")}
                        <input
                          placeholder={itemTitle(selectedItem, samples, state)}
                          value={selectedItem.recipe.title ?? ""}
                          onChange={(event) => updateSelectedRecipe((recipe) => (recipe.kind === "figure" ? { ...recipe, title: event.target.value } : recipe))}
                        />
                      </label>
                      {onOpenInIllustration && (
                        <button
                          type="button"
                          className="gl-mini-btn"
                          title={t("Load this figure into the Illustration tab")}
                          onClick={() => onOpenInIllustration(structuredClone((selectedItem.recipe as LayoutFigureRecipe).illustration))}
                        >
                          {t("Edit in Illustration")}
                        </button>
                      )}
                      <button
                        type="button"
                        className="gl-mini-btn"
                        disabled={!illustrationConfig?.figure}
                        title={t("Take the Illustration tab's current figure in place of this one")}
                        onClick={() =>
                          updateSelectedRecipe((recipe) =>
                            recipe.kind === "figure" && illustrationConfig ? { ...recipe, illustration: structuredClone(illustrationConfig) } : recipe,
                          )
                        }
                      >
                        {t("Replace with the current Illustration figure")}
                      </button>
                    </>
                  ) : selectedItem.recipe.kind === "proportions" ? (
                    <>
                      <p className="gl-hint">
                        {t("A Plotting chart, drawn here as it is there. To change it, edit it on the Plotting tab and put it back with the button below.")}
                      </p>
                      <label className="gl-field-inline gl-layout-title-field">
                        {t("Title")}
                        <input
                          placeholder={itemTitle(selectedItem, samples, state)}
                          value={selectedItem.recipe.title ?? ""}
                          onChange={(event) => updateSelectedRecipe((recipe) => (recipe.kind === "proportions" ? { ...recipe, title: event.target.value } : recipe))}
                        />
                      </label>
                      {onOpenInPlotting && (
                        <button
                          type="button"
                          className="gl-mini-btn"
                          title={t("Load this chart's settings into the Plotting tab")}
                          onClick={() => onOpenInPlotting(structuredClone((selectedItem.recipe as LayoutProportionsRecipe).settings))}
                        >
                          {t("Edit in Plotting")}
                        </button>
                      )}
                      <button
                        type="button"
                        className="gl-mini-btn"
                        disabled={!plottingSettings}
                        title={t("Take the Plotting tab's current chart in place of this one")}
                        onClick={() => {
                          const settings = plottingSettings?.();
                          if (settings) updateSelectedRecipe((recipe) => (recipe.kind === "proportions" ? { ...recipe, settings } : recipe));
                        }}
                      >
                        {t("Replace with the current Plotting chart")}
                      </button>
                    </>
                  ) : selectedItem.recipe.kind === "chart" ? (
                    <>
                      <label className="gl-field-inline">
                        {t("Population")}
                        <select
                          value={selectedItem.recipe.populationId}
                          onChange={(event) => updateSelectedRecipe((recipe) => (recipe.kind === "chart" ? { ...recipe, populationId: event.target.value } : recipe))}
                        >
                          {selectedPopulations.map(({ popId, depth }) => (
                            <option key={popId} value={popId}>
                              {"\u00a0".repeat(depth * 2)}
                              {selectedSource?.tree.populations[popId]?.name ?? popId}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="gl-field-inline">
                        {t("Statistic")}
                        <select
                          value={selectedItem.recipe.statistic}
                          onChange={(event) =>
                            updateSelectedRecipe((recipe) => {
                              if (recipe.kind !== "chart") return recipe;
                              const statistic = event.target.value as LayoutChartRecipe["statistic"];
                              const channel = statistic === "median" && !recipe.channel ? selectedSource?.sample.channels[0]?.key : recipe.channel;
                              return { ...recipe, statistic, ...(channel ? { channel } : {}) };
                            })
                          }
                        >
                          <option value="percent_of_parent">{t("% of parent")}</option>
                          <option value="percent_of_total">{t("% of total")}</option>
                          <option value="count">{t("Events")}</option>
                          <option value="median">{t("Median of a channel")}</option>
                        </select>
                      </label>
                      {selectedItem.recipe.statistic === "median" && (
                        <label className="gl-field-inline">
                          {t("Channel")}
                          <select
                            value={selectedItem.recipe.channel ?? ""}
                            onChange={(event) => updateSelectedRecipe((recipe) => (recipe.kind === "chart" ? { ...recipe, channel: event.target.value } : recipe))}
                          >
                            {(selectedSource?.sample.channels ?? []).map((channel) => (
                              <option key={channel.key} value={channel.key}>{selectedSource?.sample.labelForKey(channel.key) ?? channel.key}</option>
                            ))}
                          </select>
                        </label>
                      )}
                      <label className="gl-field-inline">
                        {t("Files")}
                        <select
                          value={selectedItem.recipe.files}
                          onChange={(event) => updateSelectedRecipe((recipe) => (recipe.kind === "chart" ? { ...recipe, files: event.target.value === "all" ? "all" : "checked" } : recipe))}
                        >
                          <option value="checked">{t("Checked files")}</option>
                          <option value="all">{t("All files")}</option>
                        </select>
                      </label>
                      <label className="gl-field-inline">
                        {t("Group by")}
                        <select
                          value={selectedItem.recipe.groupBy}
                          onChange={(event) => updateSelectedRecipe((recipe) => (recipe.kind === "chart" ? { ...recipe, groupBy: event.target.value } : recipe))}
                        >
                          <option value="">{t("Each file")}</option>
                          {metadataColumns.map((column) => (
                            <option key={column} value={column}>{column}</option>
                          ))}
                        </select>
                      </label>
                      <label className="gl-field-inline">
                        {t("Chart")}
                        <select
                          value={selectedItem.recipe.chartType}
                          onChange={(event) => updateSelectedRecipe((recipe) => (recipe.kind === "chart" ? { ...recipe, chartType: event.target.value as LayoutChartRecipe["chartType"] } : recipe))}
                        >
                          <option value="bars">{t("Bars (mean ± SD)")}</option>
                          <option value="dots">{t("Points with the mean")}</option>
                          <option value="box">{t("Boxes (median, quartiles)")}</option>
                        </select>
                      </label>
                      <label className="gl-check">
                        <input
                          type="checkbox"
                          checked={selectedItem.recipe.showPoints}
                          onChange={(event) => updateSelectedRecipe((recipe) => (recipe.kind === "chart" ? { ...recipe, showPoints: event.target.checked } : recipe))}
                        />
                        {t("Show each file as a point")}
                      </label>
                      <label className="gl-check" title={t("Wilcoxon rank-sum between two groups, Kruskal–Wallis among more; every group needs two files")}>
                        <input
                          type="checkbox"
                          checked={selectedItem.recipe.test}
                          onChange={(event) => updateSelectedRecipe((recipe) => (recipe.kind === "chart" ? { ...recipe, test: event.target.checked } : recipe))}
                        />
                        {t("Test between groups")}
                      </label>
                      <label className="gl-field-inline gl-layout-title-field">
                        {t("Title")}
                        <input
                          placeholder={itemTitle(selectedItem, samples, state)}
                          value={selectedItem.recipe.title ?? ""}
                          onChange={(event) => updateSelectedRecipe((recipe) => (recipe.kind === "chart" ? { ...recipe, title: event.target.value } : recipe))}
                        />
                      </label>
                    </>
                  ) : (
                    <>
                      <label className="gl-field-inline">
                        {t("FCS")}
                        <select
                          value={selectedItem.recipe.sampleId}
                          onChange={(event) =>
                            updateSelectedRecipe((recipe) => {
                              if (recipe.kind === "text" || recipe.kind === "figure" || recipe.kind === "proportions") return recipe;
                              const target = samples.find(
                                (file) => file.id === event.target.value,
                              );
                              if (!target) return recipe;
                              const mapped =
                                selectedSource &&
                                resolveFigurePopulation(
                                  {
                                    hierarchyId: selectedSource.tree.id,
                                    populationId: recipe.populationId,
                                    label: "",
                                  },
                                  target.tree,
                                  figureHierarchies(state),
                                );
                              return {
                                ...recipe,
                                sampleId: target.id,
                                populationId:
                                  mapped?.id ??
                                  target.tree.root_population_id ??
                                  "",
                              };
                            })
                          }
                        >
                          {samples.map((sample) => (
                            <option key={sample.id} value={sample.id}>
                              {sample.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="gl-field-inline">
                        {t("Population")}
                        <select
                          value={selectedItem.recipe.populationId}
                          onChange={(event) =>
                            updateSelectedRecipe((recipe) =>
                              recipe.kind === "text"
                                ? recipe
                                : {
                                    ...recipe,
                                    populationId: event.target.value,
                                  },
                            )
                          }
                        >
                          {selectedPopulations.map(({ popId, depth }) => (
                            <option key={popId} value={popId}>
                              {"\u00a0".repeat(depth * 2)}
                              {selectedSource?.tree.populations[popId]?.name ??
                                popId}
                            </option>
                          ))}
                        </select>
                      </label>
                      {selectedItem.recipe.kind !== "strategy" && (
                        <>
                          <label className="gl-field-inline">
                            X
                            <SearchableSelect
                              label={t("X channel")}
                              value={selectedItem.recipe.xChannel}
                              options={layoutChannelOptions}
                              onChange={(value) =>
                                updateSelectedRecipe((recipe) =>
                                  recipe.kind === "biplot" || recipe.kind === "histogram" ? { ...recipe, xChannel: value } : recipe,
                                )
                              }
                            />
                          </label>
                          {selectedItem.recipe.kind === "biplot" && (
                            <label className="gl-field-inline">
                              Y
                              <SearchableSelect
                                label={t("Y channel")}
                                value={selectedItem.recipe.yChannel ?? ""}
                                options={layoutChannelOptions}
                                onChange={(value) =>
                                  updateSelectedRecipe((recipe) =>
                                    recipe.kind === "biplot" ? { ...recipe, yChannel: value } : recipe,
                                  )
                                }
                              />
                            </label>
                          )}
                        </>
                      )}
                      {selectedItem.recipe.kind === "strategy" && (
                        <label className="gl-check">
                          <input
                            type="checkbox"
                            checked={selectedItem.recipe.fullPath}
                            onChange={(event) =>
                              updateSelectedRecipe((recipe) =>
                                recipe.kind === "strategy"
                                  ? {
                                      ...recipe,
                                      fullPath: event.target.checked,
                                    }
                                  : recipe,
                              )
                            }
                          />
                          {t("Full path from root")}
                        </label>
                      )}
                      <label className="gl-field-inline">
                        {t("Display")}
                        <select
                          value={selectedItem.recipe.displayMode}
                          onChange={(event) =>
                            updateSelectedRecipe((recipe) =>
                              recipe.kind === "text"
                                ? recipe
                                : {
                                    ...recipe,
                                    displayMode: event.target
                                      .value as LayoutDisplayMode,
                                  },
                            )
                          }
                        >
                          <option value="pseudocolor">
                            {t("Pseudocolor")}
                          </option>
                          <option value="scatter">{t("Scatter")}</option>
                          <option value="contour">{t("Contour")}</option>
                        </select>
                      </label>
                      {iteration.mode !== "off" && (
                        <label className="gl-check" title={iteration.mode === "populations" ? t("Drawn once per population of the iteration, for that population; unticked, it shows its own population on every page") : t("Drawn once per file of the iteration, for that file; unticked, it shows this file on every page")}>
                          <input
                            type="checkbox"
                            checked={selectedItem.recipe.iterated === true}
                            onChange={(event) =>
                              updateSelectedRecipe((recipe) =>
                                recipe.kind === "text" ? recipe : { ...recipe, iterated: event.target.checked },
                              )
                            }
                          />
                          {t("Follows the iteration")}
                        </label>
                      )}
                      <label className="gl-field-inline gl-layout-title-field" title={t("Empty: the sheet's title template, under Style. Placeholders: {list}", { list: TITLE_PLACEHOLDERS })}>
                        {t("Title")}
                        <input
                          placeholder={selectedTitlePreview || itemTitle(selectedItem, samples, state)}
                          value={selectedItem.recipe.title ?? ""}
                          onChange={(event) =>
                            updateSelectedRecipe((recipe) =>
                              recipe.kind === "text"
                                ? recipe
                                : { ...recipe, title: event.target.value },
                            )
                          }
                        />
                      </label>
                      <details className="gl-layout-item-style">
                        <summary>
                          {t("Style")}
                          {Object.keys((selectedItem.recipe as LayoutPlotRecipe | LayoutStrategyRecipe).style ?? {}).length > 0 ? ` · ${t("Own style")}` : ""}
                        </summary>
                        <LayoutStyleFields
                          effective={effectiveLayoutStyle(activeSheet, selectedItem.recipe)}
                          own={selectedItem.recipe.style ?? {}}
                          onChange={(patch) =>
                            updateSelectedRecipe((recipe) =>
                              !isPlotLikeRecipe(recipe)
                                ? recipe
                                : { ...recipe, style: normalizeLayoutStyle({ ...recipe.style, ...patch }) },
                            )
                          }
                        />
                        {Object.keys((selectedItem.recipe as LayoutPlotRecipe | LayoutStrategyRecipe).style ?? {}).length > 0 && (
                          <button
                            type="button"
                            className="gl-mini-btn"
                            title={t("Drop this item's own values; it then follows the sheet's style")}
                            onClick={() =>
                              updateSelectedRecipe((recipe) => {
                                if (!isPlotLikeRecipe(recipe)) return recipe;
                                const { style: _own, ...rest } = recipe;
                                return rest;
                              })
                            }
                          >
                            {t("Follow the sheet")}
                          </button>
                        )}
                      </details>
                      <button
                        type="button"
                        className="gl-mini-btn"
                        onClick={() =>
                          onOpenInGating(
                            selectedItem.recipe as
                              | LayoutPlotRecipe
                              | LayoutStrategyRecipe,
                          )
                        }
                      >
                        {t("Open in Gating")}
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          )}
          {section === "page" && (
            <>
              <h3>{t("Page")}</h3>
              <label className="gl-field-inline">
                {t("Size")}
                <select
                  value={activeSheet.page.preset}
                  onChange={(event) =>
                    setPage(pageForPreset(event.target.value as LayoutPagePreset, activeSheet.page.orientation, activeSheet.page))
                  }
                >
                  {Object.entries(LAYOUT_PAGE_PRESETS).map(([id, spec]) => (
                    <option key={id} value={id}>{spec.label}</option>
                  ))}
                  <option value="custom">{t("Custom")}</option>
                </select>
              </label>
              <label className="gl-field-inline">
                {t("Orientation")}
                <select
                  value={activeSheet.page.orientation}
                  onChange={(event) => setPage({ ...activeSheet.page, orientation: event.target.value as LayoutOrientation })}
                >
                  <option value="portrait">{t("Portrait")}</option>
                  <option value="landscape">{t("Landscape")}</option>
                </select>
              </label>
              <div className="gl-layout-dimensions">
                {(["width", "height"] as const).map((field) => (
                  <label key={field}>
                    {field === "width" ? t("Width (mm)") : t("Height (mm)")}
                    <NumberField
                      min={40}
                      max={2000}
                      step={1}
                      aria-label={field === "width" ? t("Width (mm)") : t("Height (mm)")}
                      value={pageSizeMm(activeSheet.page)[field === "width" ? "widthMm" : "heightMm"]}
                      onCommit={(value) => {
                        // The inputs show the page as measured; a landscape page stores the
                        // portrait size, so the value lands on the other side.
                        const landscape = activeSheet.page.orientation === "landscape";
                        const portraitField = (field === "width") === !landscape ? "widthMm" : "heightMm";
                        setPage({ ...activeSheet.page, preset: "custom", [portraitField]: value });
                      }}
                    />
                  </label>
                ))}
              </div>
              <label className="gl-field-inline">
                {t("Margin (mm)")}
                <NumberField
                  min={0}
                  max={100}
                  step={1}
                  value={activeSheet.page.marginMm}
                  onCommit={(marginMm) => setPage({ ...activeSheet.page, marginMm })}
                />
              </label>
              <div className="gl-layout-dimensions">
                <label>
                  {t("Pages across")}
                  <NumberField min={1} max={MAX_PAGE_GRID} step={1} integer aria-label={t("Pages across")} value={activeSheet.page.columns} onCommit={(columns) => setPage({ ...activeSheet.page, columns })} />
                </label>
                <label>
                  {t("Pages down")}
                  <NumberField min={1} max={MAX_PAGE_GRID} step={1} integer aria-label={t("Pages down")} value={activeSheet.page.rows} onCommit={(rows) => setPage({ ...activeSheet.page, rows })} />
                </label>
              </div>
              <div className="gl-layout-item-actions">
                <button type="button" className="gl-mini-btn" onClick={pageToContent} disabled={!activeSheet.items.length} title={t("Make the page a custom size that holds every item inside the margin, as one page")}>{t("Fit page to content")}</button>
                <button type="button" className="gl-mini-btn" onClick={contentToPage} disabled={!activeSheet.items.length} title={t("Scale and centre every item, as one group, to fill the first page inside its margin")}>{t("Fit content to page")}</button>
              </div>
              <h3>{t("Export")}</h3>
              <label className="gl-field-inline">
                {t("Format")}
                <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as LayoutExportFormat)}>
                  <option value="pdf">{t("PDF · the page at its size")}</option>
                  <option value="svg">{t("SVG · vector axes, gates and text")}</option>
                  <option value="png">{t("PNG")}</option>
                </select>
              </label>
              <label className="gl-field-inline">
                {t("Resolution (dpi)")}
                <NumberField
                  min={72}
                  max={1200}
                  step={1}
                  integer
                  value={activeSheet.page.dpi}
                  onCommit={(dpi) => setPage({ ...activeSheet.page, dpi })}
                />
              </label>
              <button className="gl-mini-btn" type="button" onClick={() => void exportSheet()} disabled={exporting || !activeSheet.items.length}>
                {exporting ? t("Exporting…") : t("Export sheet")}
              </button>
              <p className="gl-hint">
                {t("The export is the page at its physical size; a grid of pages is written as one PDF page each, or one SVG or PNG file each in a zip. The data layer is drawn at the resolution above and anything beyond the pages is cut off.")}
              </p>
            </>
          )}
          {section === "iterate" && (
            <>
              <h3>{t("Iterate")}</h3>
              <label className="gl-field-inline">
                {t("Draw the sheet")}
                <select
                  value={iteration.mode}
                  onChange={(event) =>
                    setIteration({ ...iteration, mode: event.target.value === "files" ? "files" : event.target.value === "populations" ? "populations" : "off" })
                  }
                >
                  <option value="off">{t("Once")}</option>
                  <option value="files">{t("Once per file")}</option>
                  <option value="populations">{t("Once per population")}</option>
                </select>
              </label>
              {iteration.mode !== "off" && (
                <>
                  {iteration.mode === "populations" && (
                    <label className="gl-field-inline">
                      {t("Populations")}
                      <select
                        value={iteration.populations?.kind === "branch" ? iteration.populations.populationId : "all"}
                        onChange={(event) =>
                          setIteration({
                            ...iteration,
                            populations: event.target.value === "all" ? { kind: "all" } : { kind: "branch", populationId: event.target.value },
                          })
                        }
                      >
                        <option value="all">{t("All in the tree")}</option>
                        {(iterationSource ? populationTreeOrder(iterationSource.tree.populations, iterationSource.tree.root_population_id ?? "") : [])
                          .filter(({ popId }) => popId !== iterationSource?.tree.root_population_id)
                          .map(({ popId, depth }) => (
                            <option key={popId} value={popId}>
                              {"\u00a0".repeat(depth * 2)}
                              {t("Under {name}", { name: iterationSource?.tree.populations[popId]?.name ?? popId })}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  {iteration.mode === "files" && (
                  <label className="gl-field-inline">
                    {t("Files")}
                    <select value={sourceKey} onChange={(event) => setIteration({ ...iteration, source: sourceFromKey(event.target.value) })}>
                      <option value="checked">{t("Checked files")}</option>
                      <option value="all">{t("All files")}</option>
                      {groups.map((group) => (
                        <option key={group.id} value={`group:${group.id}`}>{t("Group {name}", { name: group.name })}</option>
                      ))}
                      {metadataColumns.flatMap((column) =>
                        metadataValues(column).map((value) => (
                          <option key={`${column}=${value}`} value={`meta:${column}=${value}`}>{column} = {value}</option>
                        )),
                      )}
                    </select>
                  </label>
                  )}
                  <label className="gl-field-inline">
                    {t("Arrangement")}
                    <select
                      value={iteration.arrangement.kind}
                      onChange={(event) =>
                        setIteration({
                          ...iteration,
                          arrangement: event.target.value === "tiles"
                            ? { kind: "tiles", rows: 2, columns: 2, order: "row-major", gap: 24 }
                            : { kind: "page-per-unit" },
                        })
                      }
                    >
                      <option value="page-per-unit">{iteration.mode === "populations" ? t("One page per population") : t("One page per file")}</option>
                      <option value="tiles">{t("Tiles on each page")}</option>
                    </select>
                  </label>
                  {iteration.arrangement.kind === "tiles" && (
                    <>
                      <div className="gl-layout-dimensions">
                        {(["columns", "rows"] as const).map((field) => (
                          <label key={field}>
                            {field === "columns" ? t("Tiles across") : t("Tiles down")}
                            <NumberField
                              min={1}
                              max={12}
                              step={1}
                              integer
                              aria-label={field === "columns" ? t("Tiles across") : t("Tiles down")}
                              value={iteration.arrangement.kind === "tiles" ? iteration.arrangement[field] : 1}
                              onCommit={(value) => {
                                if (iteration.arrangement.kind !== "tiles") return;
                                setIteration({ ...iteration, arrangement: { ...iteration.arrangement, [field]: value } });
                              }}
                            />
                          </label>
                        ))}
                      </div>
                      <label className="gl-field-inline">
                        {t("Order")}
                        <select
                          value={iteration.arrangement.order}
                          onChange={(event) => iteration.arrangement.kind === "tiles" && setIteration({ ...iteration, arrangement: { ...iteration.arrangement, order: event.target.value === "column-major" ? "column-major" : "row-major" } })}
                        >
                          <option value="row-major">{t("Across, then down")}</option>
                          <option value="column-major">{t("Down, then across")}</option>
                        </select>
                      </label>
                      <label className="gl-field-inline">
                        {t("Gap between tiles (px)")}
                        <NumberField
                          min={0}
                          max={400}
                          step={1}
                          integer
                          value={iteration.arrangement.gap}
                          onCommit={(gap) => {
                            if (iteration.arrangement.kind === "tiles") setIteration({ ...iteration, arrangement: { ...iteration.arrangement, gap } });
                          }}
                        />
                      </label>
                    </>
                  )}
                  <p className="gl-hint">
                    {iteration.mode === "populations"
                      ? t("{units} populations of {of} → {pages} pages. Items marked “Follows the iteration” are drawn for each population; the others repeat. Text and titles may use {population}, {sample}, {file}, {n} and {N}.", { units: units.length, of: iterationSource?.name ?? "the file", pages: Math.max(1, pages.length) })
                      : t("{files} files → {pages} pages. Items marked “Follows the iteration” are drawn for each file; the others repeat. Text and titles may use {sample}, {file}, {group}, {n}, {N} and {meta:column}; a plot title may also use {population} and {count}.", { files: units.length, pages: Math.max(1, pages.length) })}
                  </p>
                </>
              )}
            </>
          )}
          {section === "style" && activeSheet && (
            <>
              <h3>{t("Style")}</h3>
              <p className="gl-hint">
                {t("How this sheet's plots are drawn. A plot or strategy may set its own values under Items; the rest follow the sheet.")}
              </p>
              <label className="gl-field-inline">
                {t("Plot titles")}
                <select
                  aria-label={t("Plot titles")}
                  value={customTitles ? "custom" : TITLE_PRESETS.find((preset) => preset.template === (activeSheet.titleTemplate ?? ""))?.id ?? "custom"}
                  onChange={(event) => {
                    const preset = TITLE_PRESETS.find((candidate) => candidate.id === event.target.value);
                    setCustomTitles(!preset);
                    mutateActiveSheet((sheet) => {
                      if (!preset) sheet.titleTemplate = sheet.titleTemplate?.trim() || "{population} · {file}";
                      else if (preset.template) sheet.titleTemplate = preset.template;
                      else delete sheet.titleTemplate;
                    });
                  }}
                >
                  {TITLE_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{t(preset.label)}</option>)}
                  <option value="custom">{t("Custom template…")}</option>
                </select>
              </label>
              {(() => {
                // A plot with a title of its own (typed under Items, or baked in by an older
                // Illustration add) does not follow the template; say so, and offer to let it.
                const own = activeSheet.items.filter((item) => ownTitleOf(item));
                if (!own.length) return null;
                return (
                  <p className="gl-hint gl-title-builder-own">
                    {t("{count} plots keep a title of their own, so the template does not reach them.", { count: own.length })}{" "}
                    <button
                      type="button"
                      className="gl-mini-btn"
                      title={t("Drop those plots' own titles so every plot on the sheet follows the template")}
                      onClick={() => mutateActiveSheet((sheet) => {
                        for (const item of sheet.items) if (isPlotLikeRecipe(item.recipe)) delete item.recipe.title;
                      })}
                    >
                      {t("Use the template for all")}
                    </button>
                  </p>
                );
              })()}
              {(customTitles || !TITLE_PRESETS.some((preset) => preset.template === (activeSheet.titleTemplate ?? ""))) && (() => {
                // The title builder: the fields chosen, in order, with one separator between them;
                // the template it makes is the sheet's, and the text field edits it directly too.
                const template = activeSheet.titleTemplate ?? "";
                const built = fieldsFromTemplate(template);
                const chosen = built?.tokens ?? [];
                const separator = built?.separator ?? builderSeparator;
                const labelOf = (token: string) => builderFields.find((field) => field.token === token)?.label ?? token;
                const setTokens = (tokens: readonly string[]) => mutateActiveSheet((sheet) => { sheet.titleTemplate = templateFromFields(tokens, separator); });
                const firstPlot = currentPage.items.find((item) => isPlotLikeRecipe(item.recipe));
                const preview = firstPlot && isPlotLikeRecipe(firstPlot.recipe)
                  ? plotTitle(template, describePlot(firstPlot.recipe, firstPlot.templateSampleId) ?? { population: "", file: "", sample: "", x: "", y: "" })
                  : "";
                return (
                  <div className="gl-title-builder" role="group" aria-label={t("Title builder")}>
                    <div className="gl-title-builder-chosen" aria-label={t("Fields in the title")}>
                      {chosen.length === 0 && (
                        <span className="gl-hint">{built === null && template ? t("Written by hand; choosing a field below starts a built title.") : t("Choose the fields below, in the order they should read.")}</span>
                      )}
                      {chosen.map((token, index) => (
                        <button
                          key={`${token}-${index}`}
                          type="button"
                          className="gl-chip active"
                          aria-label={t("Remove {field}", { field: labelOf(token) })}
                          title={t("Remove {field} from the title", { field: labelOf(token) })}
                          onClick={() => setTokens(chosen.filter((_, at) => at !== index))}
                        >
                          {labelOf(token)} ×
                        </button>
                      ))}
                    </div>
                    <div className="gl-title-builder-fields" aria-label={t("Fields to add")}>
                      {builderFields.map((field) => (
                        <button
                          key={field.token}
                          type="button"
                          className="gl-chip"
                          aria-label={t("Add {field}", { field: field.label })}
                          title={field.token}
                          onClick={() => setTokens([...chosen, field.token])}
                        >
                          {field.label}
                        </button>
                      ))}
                    </div>
                    <label className="gl-field-inline">
                      {t("Between fields")}
                      <select
                        aria-label={t("Separator")}
                        value={TITLE_SEPARATORS.find((candidate) => candidate.value === separator)?.id ?? "dot"}
                        onChange={(event) => {
                          const next = TITLE_SEPARATORS.find((candidate) => candidate.id === event.target.value)?.value ?? " · ";
                          setBuilderSeparator(next);
                          if (chosen.length) mutateActiveSheet((sheet) => { sheet.titleTemplate = templateFromFields(chosen, next); });
                        }}
                      >
                        {TITLE_SEPARATORS.map((candidate) => <option key={candidate.id} value={candidate.id}>{t(candidate.label)}</option>)}
                      </select>
                    </label>
                    <label className="gl-field-inline gl-layout-title-field">
                      {t("Template")}
                      <input
                        aria-label={t("Title template")}
                        value={template}
                        onChange={(event) => mutateActiveSheet((sheet) => { sheet.titleTemplate = event.target.value; })}
                      />
                    </label>
                    {preview && <div className="gl-hint gl-title-builder-preview">{t("First plot reads: {title}", { title: preview })}</div>}
                  </div>
                );
              })()}
              <p className="gl-hint">{t("What every plot is called unless it has a title of its own under Items. Placeholders: {list}. \"What differs across the page\" names the population when the page is one file's populations, the file when it is one population's files, both otherwise.", { list: TITLE_PLACEHOLDERS })}</p>
              <LayoutStyleFields
                effective={effectiveLayoutStyle(activeSheet)}
                own={activeSheet.style ?? {}}
                onChange={(patch) =>
                  mutateActiveSheet((sheet) => {
                    sheet.style = normalizeLayoutStyle({ ...sheet.style, ...patch });
                  })
                }
              />
              {Object.keys(activeSheet.style ?? {}).length > 0 && (
                <button
                  type="button"
                  className="gl-mini-btn"
                  onClick={() => mutateActiveSheet((sheet) => { delete sheet.style; })}
                >
                  {t("Reset to defaults")}
                </button>
              )}
            </>
          )}
        </aside>
        <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />

        <div
          ref={(el) => { (canvasRef as { current: HTMLDivElement | null }).current = el; setCanvasEl(el); }}
          className="gl-layout-canvas-scroll"
          tabIndex={0}
          aria-label={t("Layout page")}
          onKeyDown={onCanvasKeyDown}
        >
          {!preview && canvasEl && (
            <Selecto
              ref={selectoRef}
              container={canvasEl}
              dragContainer={canvasEl}
              selectableTargets={[".gl-layout-item"]}
              selectByClick
              selectFromInside={false}
              continueSelect={false}
              toggleContinueSelect={["shift"]}
              hitRate={0}
              ratio={0}
              dragCondition={(e) => !(e.inputEvent?.target as HTMLElement | undefined)?.closest?.("textarea, input, select, button")}
              onDragStart={onSelectoDragStart}
              onSelectEnd={onSelectEnd}
            />
          )}
          <div
            className="gl-layout-zoom"
            style={{ width: activeSheet.width * zoom, height: activeSheet.height * zoom }}
          >
          <section
            ref={(el) => { (pageRef as { current: HTMLElement | null }).current = el; setPageEl(el); }}
            className="gl-layout-canvas"
            aria-label={activeSheet.name}
            onContextMenu={openCanvasMenu}
            style={{ width: activeSheet.width, height: activeSheet.height, transform: `scale(${zoom})` }}
          >
            {pageOrigins(activeSheet.page).map((origin) => {
              const one = pageSizePx(activeSheet.page);
              const margin = mmToPx(activeSheet.page.marginMm);
              return (
                <div key={`${origin.row}-${origin.column}`} className="gl-layout-page" aria-hidden="true" style={{ left: origin.x, top: origin.y, width: one.width, height: one.height }}>
                  {margin > 0 && <div className="gl-layout-page-margin" style={{ inset: margin }} />}
                </div>
              );
            })}
            {currentPage.items.length === 0 && (
              <div className="gl-layout-empty">
                <strong>{t("Blank layout")}</strong>
                <span>
                  {t(
                    "Add a plot, gating strategy, text, or the current Illustration selection.",
                  )}
                </span>
              </div>
            )}
            {currentPage.items.map((item) => (
              <LayoutItemFrame
                key={item.id}
                item={item}
                templateText={(() => { const template = activeSheet.items.find((candidate) => candidate.id === item.templateId); return template?.recipe.kind === "text" ? template.recipe.text : undefined; })()}
                selected={selectedIds.includes(item.id)}
                samples={samples}
                state={state}
                globalScales={globalScales}
                dataRevision={dataRevision}
                densityColorPower={densityColorPower}
                style={effectiveLayoutStyle(activeSheet, item.recipe)}
                titleTemplate={ownTitleOf(item, item.templateSampleId) || sheetTitleTemplate}
                describe={describePlot}
                checkedSampleIds={checkedSampleIds}
                metadataById={metadataById}
                files={files}
                sources={sourceResult.sources}
                divisionProfiles={divisionProfiles}
                canvasScale={canvasScale}
                onTextChange={(text, contentHeight) =>
                  mutateActiveSheet((sheet) => {
                    const target = sheet.items.find(
                      (candidate) => candidate.id === item.templateId,
                    );
                    if (target?.recipe.kind !== "text") return;
                    target.recipe.text = text;
                    // A block grows to show every line it was given; it never shrinks on its own.
                    if (contentHeight > 0) target.height = Math.max(target.height, Math.ceil(contentHeight) + 4);
                  })
                }
                onDelete={() => removeItems([item.templateId])}
                onOpenInGating={() => {
                  if (isPlotLikeRecipe(item.recipe)) onOpenInGating(item.recipe);
                }}
                onTextFocus={() => { if (!selectedIds.includes(item.id) || selectedIds.length > 1) setSelectedIds([item.id]); }}
                onTextEscape={() => canvasRef.current?.focus({ preventScroll: true })}
              />
            ))}
            {!preview && selectedElements.length > 0 && (
              <Moveable
                ref={moveableRef}
                target={selectedElements.length === 1 ? selectedElements[0] : selectedElements}
                zoom={1 / zoom}
                origin={false}
                checkInput
                // The overlay Moveable draws over a group lets presses through, so a member's
                // editor can take focus and a click on a member can select it alone.
                passDragArea
                draggable={!selectionLocked}
                resizable={!selectionLocked}
                snappable
                snapThreshold={6}
                // The red distance digits Moveable draws beside a snap guideline were large and
                // startling on a zoomed page and say nothing the guideline does not; guidelines stay.
                isDisplaySnapDigit={false}
                isDisplayInnerSnapDigit={false}
                snapDirections={SNAP_DIRECTIONS}
                elementSnapDirections={SNAP_DIRECTIONS}
                elementGuidelines={guideElements}
                verticalGuidelines={pageGuides.vertical}
                horizontalGuidelines={pageGuides.horizontal}
                snapGridWidth={snapToGrid ? SNAP_GRID : 0}
                snapGridHeight={snapToGrid ? SNAP_GRID : 0}
                renderDirections={["nw", "n", "ne", "w", "e", "sw", "s", "se"]}
                edge
                onDragStart={(e: OnDragStart) => { e.datas.alt = !!e.inputEvent?.altKey; if (e.datas.alt) e.datas.ghosts = leaveGhosts([e.target]); }}
                onDrag={applyDrag}
                onDragEnd={(e: OnDragEnd) => { removeGhosts(e.datas.ghosts); if (e.isDrag) commitFrames([e.target], !!e.datas.alt); }}
                onDragGroupStart={(e: OnDragGroupStart) => { e.datas.alt = !!e.inputEvent?.altKey; if (e.datas.alt) e.datas.ghosts = leaveGhosts(e.targets); }}
                onDragGroup={(e: OnDragGroup) => e.events.forEach(applyDrag)}
                onDragGroupEnd={(e: OnDragGroupEnd) => { removeGhosts(e.datas.ghosts); if (e.isDrag) commitFrames(e.targets, !!e.datas.alt); }}
                onResize={applyResize}
                onResizeEnd={(e: OnResizeEnd) => { if (e.isDrag) commitFrames([e.target], false); }}
                onResizeGroup={(e: OnResizeGroup) => e.events.forEach(applyResize)}
                onResizeGroupEnd={(e: OnResizeGroupEnd) => { if (e.isDrag) commitFrames(e.targets, false); }}
                // A click on one member of a selected group selects that member alone (Shift keeps the group).
                onClickGroup={(e: OnClickGroup) => { selectoRef.current?.clickTarget(e.inputEvent, e.inputTarget); }}
              />
            )}
          </section>
          </div>
        </div>
      </div>
    </div>
  );
}

import {
  Fragment,
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
  type OnResizeGroupStart,
  type OnResizeStart,
  type OnClick,
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
  DEFAULT_LAYOUT_STYLE,
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
import { buildIllustrationPayload, type IllustrationOptions } from "../engine/illustration";
import { buildPooledPlotPayload, poolCompatibility, pooledGateAgreement, type PooledMember } from "../engine/pooledPlot";
import { facetColumns, groupCheckedCount, toggleGroupChecked } from "../engine/sampleFacets";
import type { CSSProperties } from "react";
import {
  computeGatingStrategy,
  buildStrategyPayload,
} from "../engine/strategy";
import { buildMultiStrategyPayload, computeMultiPopStrategy, flowLayout, tidyLayout } from "../engine/multiStrategy";
import { drawStrategyArrows, reserveArrowGutters, strategyArrowGap, strategyArrows } from "./strategyArrows";
import { populationTreeOrder } from "../engine/populations";
import { loadMiniPlots } from "../plots/loadPlots";
import { composeSheetPages, writeComposedPages, type ComposedPage, type LayoutExportFormat } from "../plots/layoutExport";
import { DEFAULT_ITERATION, expandLayoutSheet, followsIteration, iterationUnits, metadataUnits, populationUnits, sharedMetadataFields, templateFrame, type DescribeBoundPlot, type LayoutIteration, type LayoutPage as ExpandedPage, type LayoutPageItem } from "../engine/layoutBatch";
import { automaticTitleTemplate, fieldsFromTemplate, plotTitle, plotTitleContext, templateFromFields, titleFields, TITLE_PLACEHOLDERS, TITLE_PRESETS, TITLE_SEPARATORS } from "../engine/layoutTitle";
import { alignItems, arrangeUnits, distributeItems, fitContentToPage, fitPageToContent, groupItems, ungroupItems, type AlignHow, type DistributeHow } from "../engine/layoutArrange";
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
  /** The level order of the metadata columns that have one, by column: the order a metadata iteration draws the values in. */
  metadataLevels?: Readonly<Record<string, readonly string[]>>;
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
  /** Called when a sheet has been written out, for whoever counts that (the tutorial). */
  onExported?: () => void;
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
  { how: "horizontal", label: "Distribute ↔", title: "Equal spacing between three or more items or groups, left to right; the outer two stay where they are" },
  { how: "vertical", label: "Distribute ↕", title: "Equal spacing between three or more items or groups, top to bottom; the outer two stay where they are" },
];
/** The frame an element shows now, from its inline style: what Moveable moved or resized. */
/**
 * Stop the drag or resize Moveable has under way. With each item in its own frame the gesture
 * belongs to one of the child frames, which the outer instance does not stop on its own.
 */
function stopMoveableDrags(moveable: Moveable | null): void {
  if (!moveable) return;
  moveable.stopDrag();
  const manager = moveable.getManager?.() as { getMoveables?: () => { stopDrag?: () => void }[] } | undefined;
  for (const child of manager?.getMoveables?.() ?? []) if (child !== (manager as unknown)) child.stopDrag?.();
}

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
  const pool = poolOf(recipe);
  if (pool) return `${population?.name ?? "Population"} · ${pool.length} files`;
  return `${population?.name ?? "Population"} · ${sample?.name ?? "FCS"}`;
}

/** The files a plot pools, when it pools more than one; null for a plot of one file. */
function poolOf(recipe: LayoutRecipe): string[] | null {
  return (recipe.kind === "biplot" || recipe.kind === "histogram") && recipe.pool && recipe.pool.sampleIds.length > 1
    ? recipe.pool.sampleIds
    : null;
}

/**
 * The pooled files that can join a plot, the reference file first: each with the plot's
 * population followed into its own tree and its channels compatible with the reference's. The
 * others are named with why, so a pool never narrows in silence.
 */
function resolvePoolMembers(
  recipe: LayoutPlotRecipe,
  samples: readonly LayoutSampleView[],
  trees: Record<string, StoredHierarchy>,
  templateTreeId?: string,
): { members: PooledMember[]; leftOut: { name: string; reason: string }[] } {
  const ids = recipe.pool?.sampleIds ?? [recipe.sampleId];
  const reference = samples.find(({ id }) => id === recipe.sampleId) ?? samples.find(({ id }) => ids.includes(id)) ?? null;
  const members: PooledMember[] = [];
  const leftOut: { name: string; reason: string }[] = [];
  if (!reference) return { members, leftOut };
  const y = recipe.kind === "histogram" ? null : recipe.yChannel;
  for (const id of [reference.id, ...ids.filter((candidate) => candidate !== reference.id)]) {
    const view = samples.find((candidate) => candidate.id === id);
    if (!view) {
      leftOut.push({ name: id, reason: "not loaded" });
      continue;
    }
    const resolved = resolvePopulationInTree(recipe.populationId, view.tree, trees, templateTreeId ?? reference.tree.id);
    if (resolved.missing) {
      leftOut.push({ name: view.name, reason: "no corresponding population" });
      continue;
    }
    const reason = view === reference ? null : poolCompatibility(reference.sample, view.sample, recipe.xChannel, y);
    if (reason) {
      leftOut.push({ name: view.name, reason });
      continue;
    }
    members.push({ id: view.id, name: view.name, sample: view.sample, tree: view.tree, gating: view.derived, populationId: resolved.id });
  }
  return { members, leftOut };
}

/** What a pooled plot's inspector says of its pool: how many files joined, which did not and why, and the gates left out. */
interface PoolReport {
  pooled: number;
  total: number;
  leftOut: { name: string; reason: string }[];
  omittedGates: string[];
}

/**
 * The files a plot pools: a checklist with a search, the quick picks the iteration offers
 * (the checked files, every file, a group) and the metadata chips of the file list, each a
 * bulk checkbox for its value.
 */
function LayoutPoolPicker({
  files,
  pool,
  checkedSampleIds,
  groups,
  fileGroups,
  report,
  onChange,
}: Readonly<{
  files: readonly FigureSample[];
  pool: readonly string[];
  checkedSampleIds: readonly string[];
  groups: readonly { id: string; name: string }[];
  fileGroups: Readonly<Record<string, string>>;
  report: PoolReport | null;
  onChange: (sampleIds: string[]) => void;
}>) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const metadata = useMemo(
    () => Object.fromEntries(files.filter((file) => file.metadata).map((file) => [file.id, file.metadata!])),
    [files],
  );
  const facets = useMemo(
    () => facetColumns(metadata, [...new Set(Object.values(metadata).flatMap((row) => Object.keys(row)))].map((name) => ({ name }))),
    [metadata],
  );
  const excluded = useMemo(() => new Set(files.filter((file) => !pool.includes(file.id)).map((file) => file.id)), [files, pool]);
  const inFileOrder = (ids: ReadonlySet<string> | readonly string[]) =>
    files.filter((file) => (ids instanceof Set ? ids.has(file.id) : (ids as readonly string[]).includes(file.id))).map((file) => file.id);
  const query = search.trim().toLowerCase();
  return (
    <div className="gl-layout-pool">
      <div className="gl-figure-actions gl-figure-list-actions">
        <button type="button" onClick={() => onChange(inFileOrder(checkedSampleIds))}>{t("Checked files")}</button>
        <button type="button" onClick={() => onChange(files.map((file) => file.id))}>{t("All files")}</button>
        {groups.map((group) => (
          <button key={group.id} type="button" onClick={() => onChange(files.filter((file) => fileGroups[file.id] === group.id).map((file) => file.id))}>
            {t("Group {name}", { name: group.name })}
          </button>
        ))}
      </div>
      <input
        type="search"
        aria-label={t("Find files to pool")}
        placeholder={t("Find file / sample…")}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="gl-figure-list gl-layout-pool-list">
        {files
          .filter((file) => !query || `${file.name} ${file.fileName ?? ""}`.toLowerCase().includes(query))
          .map((file) => (
            <label key={file.id} className="gl-figure-row" title={file.fileName && file.fileName !== file.name ? `${file.name} · ${file.fileName}` : file.name}>
              <input
                type="checkbox"
                checked={pool.includes(file.id)}
                onChange={() => onChange(pool.includes(file.id) ? pool.filter((id) => id !== file.id) : inFileOrder([...pool, file.id]))}
              />
              <span className="gl-figure-row-name">{file.name}</span>
            </label>
          ))}
      </div>
      {facets.length > 0 && (
        <div className="gl-sample-facets gl-figure-facets" aria-label={t("Select pooled files by metadata")}>
          {facets.map((column) => (
            <div key={column.name} className="gl-sample-facet-row">
              <span className="gl-sample-facet-lock" aria-hidden="true" />
              <span className="gl-sample-facet-name" title={column.name}>{column.name}</span>
              <div className="gl-sample-facet-values">
                {column.values.map((entry) => {
                  const on = groupCheckedCount(entry.sampleIds, excluded);
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
                      title={`${entry.value}: ${on} of ${total} pooled — ${on === total ? `click to drop all ${total}` : `click to pool all ${total}`}`}
                      onClick={() => onChange(inFileOrder(new Set(files.filter((file) => !toggleGroupChecked(entry.sampleIds, excluded).has(file.id)).map((file) => file.id))))}
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
      )}
      {report && (
        <p className="gl-hint">
          {t("{n} of {m} files pooled", { n: report.pooled, m: report.total })}
          {report.leftOut.length > 0 && ` · ${t("Not pooled: {files}", { files: report.leftOut.map((entry) => `${entry.name} (${entry.reason})`).join(", ") })}`}
          {report.omittedGates.length > 0 && ` · ${t("Gates not shown: {names} — they differ between the pooled files", { names: report.omittedGates.join(", ") })}`}
        </p>
      )}
    </div>
  );
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
  const trees = useMemo(() => figureHierarchies(activeState), [activeState]);
  const source =
    recipe.kind === "text"
      ? null
      : (samples.find(({ id }) => id === recipe.sampleId) ?? null);
  // A pooled plot is drawn from every pooled file's view; it is drawn again when any of them is
  // prepared again, as a plot of one file is when its view is.
  const pool = poolOf(recipe);
  const poolKey = pool?.join("|") ?? "";
  const memberViews = useMemo(
    () => (poolKey ? poolKey.split("|").map((id) => samples.find((view) => view.id === id) ?? null) : null),
    [samples, poolKey],
  );
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
    return resolvePopulationInTree(recipe.populationId, source.tree, trees, templateSource?.tree.id);
  })();
  const populationId = resolvedPopulation.id;
  const missingPopulationName = resolvedPopulation.missing
    ? (templateSource?.tree.populations[recipe.kind === "text" ? "" : recipe.populationId]?.name ?? "the population")
    : null;

  // The title as drawn, resolved here so the effect below keys on the words and not on the
  // describe callback's identity: the plot is drawn again when its template, file or population
  // changes, and not when the tab renders for a selection.
  const boundContext = recipe.kind === "text" ? null : describe({ ...recipe, populationId }, undefined, item.unitId);
  const fillTitle = (template: string) => (boundContext ? plotTitle(template, boundContext) : template);
  const drawnTitle = recipe.kind === "strategy" ? fillTitle(recipe.title?.trim() || "{population}") : fillTitle(titleTemplate);
  const recipeKey = JSON.stringify(recipe);

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
      const availableWidth = Math.max(120, item.width - 8);
      const availableHeight = Math.max(120, item.height - 8);

      if (recipe.kind === "strategy" && recipe.populationIds?.length) {
        // The Strategy tab's multi-population grid, as a block: every step to each population,
        // on this file's tree (the ids followed into it by lineage), laid out as asked and sized
        // so the whole grid fits the frame; the arrows run through the gutters as on the tab.
        const tree = source.tree;
        const rootId = tree.root_population_id ?? "";
        const ids = recipe.populationIds
          .map((id) => resolvePopulationInTree(id, tree, trees, templateSource?.tree.id))
          .filter((resolved) => !resolved.missing)
          .map((resolved) => resolved.id);
        const computed = computeMultiPopStrategy(source.sample, tree.gates, tree.populations, rootId, source.derived.masks, ids, { maxEvents: style.maxEvents, globalScales });
        const columnsAsked = Math.max(1, recipe.columns ?? 4);
        const nodes = recipe.layout === "flow" ? flowLayout(computed, columnsAsked, tree.populations) : tidyLayout(computed, tree.populations);
        if (!nodes.length) {
          host.textContent = `${source.name} has none of the strategy's populations.`;
          host.className = "gl-layout-plot-host is-missing";
          return;
        }
        // Drawn at the size it was made at on the Strategy tab and scaled as a whole to the frame:
        // the block arrives as it was, and a resized frame keeps the fonts, gates and gutters in
        // proportion (drawing the panels smaller instead ran into the renderer's smallest panel,
        // and the grid spilled out of its frame).
        const showArrows = recipe.showArrows !== false;
        const arrows = showArrows ? strategyArrows(nodes, tree.populations) : [];
        const gap = showArrows ? strategyArrowGap(arrows) : 8;
        const plotSize = Math.max(120, Math.min(800, recipe.plotSize ?? 200));
        host.removeAttribute("id");
        const inner = document.createElement("div");
        inner.id = `layout-strategy-${item.id}`;
        inner.style.width = "max-content";
        host.appendChild(inner);
        const draw = (scale: number) => {
          const payload = buildMultiStrategyPayload(nodes, {
            displayMode: recipe.displayMode,
            plotSize,
            contourThreshold: style.contourThreshold,
            contourLevels: style.contourLevels,
            pointAlpha: style.pointAlpha,
            densityColorPower,
            pointSize: style.pointSize,
            kdeBandwidth: style.kdeBandwidth,
            pubStyle: style.pubStyle,
            gateLineWidth: style.gateLineWidth,
            gateLabelFormat: style.gateLabels,
            gateLabelBold: recipe.gateLabelBold,
            labelBackground: recipe.labelBackground,
            gridGap: gap,
            canvasScale: canvasScale * scale,
            fontSizes: fontSizesOf(style),
            contextTitle: drawnTitle,
          });
          loadMiniPlots().renderMultiStrategyGrid(inner.id, payload);
        };
        draw(1);
        // Measured with the right and bottom gutters the arrows run in, so the frame holds them.
        if (showArrows) reserveArrowGutters(inner);
        const naturalWidth = inner.scrollWidth, naturalHeight = inner.scrollHeight;
        const fit = naturalWidth > 0 && naturalHeight > 0
          ? Math.max(0.1, Math.min(4, availableWidth / naturalWidth, availableHeight / naturalHeight))
          : 1;
        if (Math.abs(fit - 1) > 0.01) {
          inner.style.zoom = String(fit);
          // Redrawn at the zoomed resolution, so the points stay sharp.
          draw(fit);
        }
        drawStrategyArrows(inner, arrows, { color: recipe.arrowColor ?? (style.pubStyle ? "#444444" : null), width: recipe.arrowWidth ?? 1.5, anchor: recipe.arrowAnchor ?? "label" });
        return;
      }

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
            contextTitle: drawnTitle,
          },
        );
        host.id = `layout-strategy-${item.id}`;
        for (const plot of Object.values((payload as { plots?: Record<string, Record<string, unknown>> }).plots ?? {})) plot.canvas_scale = canvasScale;
        loadMiniPlots().renderStrategyGrid(host.id, payload);
        return;
      }

      const plotSize = Math.max(120, Math.min(availableWidth, availableHeight));
      const yChannel = recipe.kind === "histogram" ? null : recipe.yChannel;
      const options: IllustrationOptions = {
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
      };
      const draw = (plot: Record<string, unknown>, gates: unknown[]) =>
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
          title: drawnTitle,
          contour_levels: style.contourLevels,
          font_sizes: fontSizesOf(style),
          gate_style: { pub_style: style.pubStyle, line_width: style.gateLineWidth, label_format: style.gateLabels },
          pop_color: "#334155",
          gates,
        });
      if (memberViews) {
        // The pooled files' events on one plot, by the rules the Illustration tab pools by: the
        // reference file's axes, the cap shared out, the counts summed, the gates the files hold
        // alike labelled with the pooled percentage.
        const { members } = resolvePoolMembers(recipe, samples, trees, templateSource?.tree.id);
        const pooled = members.length
          ? buildPooledPlotPayload(members, recipe.xChannel, yChannel, globalScales, options, trees)
          : null;
        if (!pooled) {
          host.textContent = "No events are available for this FCS/population combination.";
          host.className = "gl-layout-plot-host is-missing";
          return;
        }
        draw(pooled.config, pooled.gates);
        return;
      }
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
        options,
        source.derived.gateMasks,
      ) as {
        plots?: Record<string, Record<string, unknown>>;
        gate_overlays?: Record<string, unknown[]>;
      };
      const key = `${populationId}|${recipe.xChannel}`;
      const plot = payload.plots?.[key];
      if (!plot) {
        host.textContent =
          "No events are available for this FCS/population combination.";
        host.className = "gl-layout-plot-host is-missing";
        return;
      }
      draw(plot, payload.gate_overlays?.[key] ?? []);
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
    recipeKey,
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
    drawnTitle,
    memberViews,
    trees,
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
  onTextChange,
  onTextFocus,
  textEditing,
  onTextEditStart,
  onTextEditEnd,
  onIsolate,
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
  /** The text as committed, with the height its lines need, so the frame can grow to show them. */
  onTextChange: (text: string, contentHeight: number) => void;
  /** The text editor took focus: a click on a text block's words selects the block. */
  onTextFocus: () => void;
  /** Whether this text block's editor is open; a double-click or Enter opens it, leaving it closes it. */
  textEditing: boolean;
  onTextEditStart: () => void;
  onTextEditEnd: () => void;
  /** A double-click on this member of a selected group: the member alone, when the tab allows it. */
  onIsolate?: () => void;
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
      title={`${item.locked ? `${t("Locked")} · ` : ""}${itemTitle(item, samples, state)}`}
      data-title={itemTitle(item, samples, state)}
      onDoubleClick={onIsolate ? (event) => { event.stopPropagation(); onIsolate(); } : undefined}
      className={`gl-layout-item${selected ? " is-selected" : ""}${item.showFrame ? " has-frame" : ""}${item.recipe.kind === "text" ? " is-text" : ""}${item.locked ? " is-locked" : ""}`}
      style={{
        left: item.x,
        top: item.y,
        width: item.width,
        height: item.height,
        zIndex: item.z,
      }}
    >
      <div className="gl-layout-item-body" style={zoom === 1 ? undefined : { zoom, width: inner.width, height: inner.height }}>
      {item.recipe.kind === "text" ? (
        <LayoutTextEditor
          text={item.recipe.text}
          templateText={templateText ?? item.recipe.text}
          fontSize={item.recipe.fontSize}
          bold={item.recipe.bold}
          editing={textEditing}
          onEditStart={onTextEditStart}
          onEditEnd={onTextEditEnd}
          onCommit={onTextChange}
          onFocus={onTextFocus}
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
        <Fragment key={key}>
          <label className={"gl-field-inline" + (key in own ? " is-own" : "")}>
            {t(label)}
            <NumberField
              aria-label={t(label)}
              value={key === "maxEvents" && effective.maxEvents === 0 ? DEFAULT_LAYOUT_STYLE.maxEvents : effective[key]}
              min={LAYOUT_STYLE_RANGES[key][0]}
              max={LAYOUT_STYLE_RANGES[key][1]}
              step={step}
              integer={integer}
              disabled={key === "maxEvents" && effective.maxEvents === 0}
              onCommit={(value) => onChange({ [key]: value })}
            />
          </label>
          {key === "maxEvents" && (
            // An event cap of 0 is every event, as on the Gating tab: a pooled plot of a whole SCE
            // can then be drawn as the Gating tab's pooled view draws it.
            <label className={"gl-check" + ("maxEvents" in own ? " is-own" : "")} title={t("Draw every event of the plot's files rather than a sample of them; a plot of a million points repaints slowly. Counts and percentages always use every event.")}>
              <input
                type="checkbox"
                checked={effective.maxEvents === 0}
                onChange={(event) => onChange({ maxEvents: event.target.checked ? 0 : DEFAULT_LAYOUT_STYLE.maxEvents })}
              />
              {t("All events")}
            </label>
          )}
        </Fragment>
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

/**
 * A text block's words. As placed they are static text, so the block is selected and dragged by
 * its body like any other item; a double-click, or Enter with the block selected, opens the
 * editor, which shows the template with its placeholders. Leaving the editor, by Escape, a
 * click elsewhere or Tab, keeps what was typed, as the vector editors do.
 */
function LayoutTextEditor({
  text,
  templateText,
  fontSize,
  bold,
  editing,
  onEditStart,
  onEditEnd,
  onCommit,
  onFocus,
}: {
  /** The text as shown: the template's with its placeholders filled in. */
  text: string;
  /** The text as written, which is what editing changes. */
  templateText: string;
  fontSize: number;
  bold?: boolean;
  editing: boolean;
  onEditStart: () => void;
  onEditEnd: () => void;
  onCommit: (text: string, contentHeight: number) => void;
  onFocus: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(templateText);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) return;
    setDraft(templateText);
    const area = areaRef.current;
    if (!area) return;
    area.focus({ preventScroll: true });
    area.setSelectionRange(area.value.length, area.value.length);
    // The editor opens on the template as it is then; what it holds after is the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  const style = { fontSize, fontWeight: bold ? 700 : 400 };
  if (!editing) {
    return (
      <div
        className="gl-layout-text-surface is-static"
        style={style}
        title={t("Double-click to edit")}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onEditStart();
        }}
      >
        {text}
      </div>
    );
  }
  return (
    <textarea
      ref={areaRef}
      className="gl-layout-text-surface"
      aria-label="Layout text"
      value={draft}
      style={style}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={onFocus}
      onBlur={(event) => {
        if (draft !== templateText) onCommit(draft, event.currentTarget.scrollHeight);
        onEditEnd();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") event.currentTarget.blur();
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
  metadataLevels,
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
  onExported,
}: Readonly<Props>) {
  const { t } = useI18n();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  /** The text block whose editor is open, by its page id. */
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
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
  // The modifier keys as held, read on the window so a gesture under way changes with them:
  // Shift keeps a resize's proportions and holds a drag to 45° steps, Cmd turns snapping off.
  const [modifiers, setModifiers] = useState({ shift: false, meta: false });
  useEffect(() => {
    const read = (event: KeyboardEvent) => setModifiers((current) => {
      const next = { shift: event.shiftKey, meta: event.metaKey || event.ctrlKey };
      return next.shift === current.shift && next.meta === current.meta ? current : next;
    });
    const clear = () => setModifiers((current) => (current.shift || current.meta ? { shift: false, meta: false } : current));
    window.addEventListener("keydown", read);
    window.addEventListener("keyup", read);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", read);
      window.removeEventListener("keyup", read);
      window.removeEventListener("blur", clear);
    };
  }, []);
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
  // Cropped, the export is each page's items plus this much white around them, not the paper.
  const [exportCrop, setExportCrop] = useState(false);
  const [exportPaddingMm, setExportPaddingMm] = useState(3);
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
  // One view per prepared source, held while the sources are: the plot surfaces key their
  // drawing on these objects, so a render of the tab must not hand them new ones.
  const samples: LayoutSampleView[] = useMemo(
    () => (sourceResult.current ? sourceResult.sources.map((source) => ({ ...source, derived: source.gating })) : []),
    [sourceResult.current, sourceResult.sources],
  );
  const metadataById = useMemo(
    () => Object.fromEntries(files.map((file) => [file.id, file.metadata])) as Record<string, Readonly<Record<string, string>> | undefined>,
    [files],
  );
  const trees = useMemo(() => figureHierarchies(state), [state]);
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
        : iteration.mode === "metadata"
          ? metadataUnits(iteration, files, checkedSampleIds, groups, fileGroups, metadataLevels?.[iteration.column ?? ""])
          : iterationUnits(iteration, files, checkedSampleIds, groups, fileGroups),
    [iteration, files, checkedSampleIds, groups, fileGroups, iterationSource, metadataLevels],
  );
  /** What a plot's placeholders read: its file (display id, name, metadata), its population (followed into the file's tree when drawn for another) and its count. */
  const describePlot: DescribeBoundPlot = useCallback((recipe, templateSampleId, unitId) => {
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
    const pool = poolOf(recipe);
    if (pool && recipe.kind !== "strategy") {
      // A pool reads as its files: how many, the metadata they share, and the population's
      // events over all of them.
      const { members } = resolvePoolMembers(recipe, samples, trees, templateSampleId ? samples.find(({ id }) => id === templateSampleId)?.tree.id : undefined);
      const pooledCount = members.reduce((total, member) => total + (member.gating.stats.event_count[member.populationId] ?? 0), 0);
      // A pool drawn for a metadata value is named by the value; a hand-picked one by its size.
      const unit = unitId ? units.find((candidate) => candidate.id === unitId) : undefined;
      return plotTitleContext(
        recipe,
        { name: unit?.sampleIds ? unit.name : `${pool.length} files`, fileName: `${pool.length} files`, metadata: sharedMetadataFields(pool.map((id) => metadataById[id])) },
        population ? { id: populationId, name: population.name } : null,
        members.length ? pooledCount : undefined,
        populationMetadata,
      );
    }
    const count = view?.derived.stats.event_count[populationId];
    return plotTitleContext(
      recipe.kind === "strategy" ? {} : recipe,
      file ? { name: file.name, fileName: file.fileName ?? file.name, metadata: file.metadata } : null,
      population ? { id: populationId, name: population.name } : null,
      typeof count === "number" ? count : undefined,
      populationMetadata,
    );
  }, [files, samples, state, populationMetadata, trees, metadataById, units]);
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
      // A pool counts as a file of its own, so two pools of one reference file still differ by file.
      ? [{ sampleId: poolOf(item.recipe)?.join(",") ?? item.recipe.sampleId, populationId: item.recipe.populationId, label: item.recipe.kind === "strategy" ? undefined : item.recipe.label }]
      : []),
    iteration.mode === "metadata" ? { metadataColumn: iteration.column } : undefined,
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
  /** The tile a page id carries, so a group on a tiled page is taken within its tile. */
  const tileOf = (id: string) => id.split("::")[1] ?? "";
  const groupOfPageId = (id: string) => currentPage.items.find((item) => item.id === id)?.group;
  /** The ids with every member of their groups added: a group is selected whole, as in the vector editors. */
  const withGroupMembers = (ids: readonly string[]): string[] => {
    const groups = new Set(ids.map(groupOfPageId).filter((group): group is string => !!group));
    if (!groups.size) return [...ids];
    const tiles = new Set(ids.map(tileOf));
    const out = new Set(ids);
    for (const item of currentPage.items) if (item.group && groups.has(item.group) && tiles.has(tileOf(item.id))) out.add(item.id);
    return [...out];
  };
  /** How many things the arrange tools would move: a group counts once. */
  const selectedUnitCount = arrangeUnits(selectedItems).length;
  const selectionGrouped = selectedItems.length > 1 && selectedItems.every((item) => item.group && item.group === selectedItems[0].group);
  /** A plot's own title, typed under Items; empty for none, or for one GateLab baked in before the template existed. */
  const ownTitleOf = (item: LayoutItem, templateSampleId?: string): string => {
    if (!isPlotLikeRecipe(item.recipe)) return "";
    const title = item.recipe.title?.trim() ?? "";
    if (!title) return "";
    const context = describePlot(item.recipe, templateSampleId);
    return context && isBakedTitle(title, context.population, [context.file, context.sample]) ? "" : title;
  };
  const selectedTitlePreview = selectedPageItem && isPlotLikeRecipe(selectedPageItem.recipe)
    ? plotTitle(sheetTitleTemplate, describePlot(selectedPageItem.recipe, selectedPageItem.templateSampleId, selectedPageItem.unitId) ?? { population: "", file: "", sample: "", x: "", y: "" })
    : "";
  const selectionLocked = selectedItems.some((item) => item.locked);
  const lockedTemplateIds = new Set((activeSheet?.items ?? []).filter((item) => item.locked).map((item) => item.id));
  // A locked item can be selected, to unlock it, but it keeps its place and size: Moveable takes
  // only the selected items that are not locked, so a mixed selection moves the rest.
  // A text block being edited keeps its selection but shows no frame, as the editors do, so the
  // handles do not sit over the words being typed.
  const movableElements = selectedElements.filter((el) => !lockedTemplateIds.has(templateIdOf(el.dataset.itemId ?? "")) && el.dataset.itemId !== editingTextId);
  // Several items with no group among them each keep their own frame and handles, as PowerPoint
  // and Keynote draw them, so Ungroup shows at once; a drag on any of them moves them all, and a
  // handle resizes its own item. A group, alone or with other items, is drawn as one frame, which
  // moves and scales the selection whole.
  const ownFrames = movableElements.length > 1 && movableElements.every((el) => !groupOfPageId(el.dataset.itemId ?? ""));
  const movableRef = useRef(movableElements);
  movableRef.current = movableElements;
  // A press Selecto handed to Moveable (an item selected and dragged in one press) was already
  // Selecto's click: an item's own frame reports it again when it is released, and taken as a
  // click it would undo the selection just made. Cleared by the next press.
  const handedOffRef = useRef(false);

  useEffect(() => {
    if (selectedIds.length && selectedIds.some((id) => !currentPage.items.some((item) => item.id === id))) {
      setSelectedIds((current) => current.filter((id) => currentPage.items.some((item) => item.id === id)));
    }
  }, [currentPage, selectedIds]);
  // After the page's items have been laid out again, the frame is measured again as well: the
  // observers catch a changed style, and this catches what they do not (a zoom, a page change).
  useLayoutEffect(() => {
    moveableRef.current?.updateRect();
  }, [currentPage, zoom, settledZoom]);
  useLayoutEffect(() => {
    if (!pageEl) return;
    const all = [...pageEl.querySelectorAll<HTMLElement>("[data-item-id]")];
    const same = (a: HTMLElement[], b: HTMLElement[]) => a.length === b.length && a.every((el, i) => el === b[i]);
    const selected = all.filter((el) => selectedIds.includes(el.dataset.itemId ?? ""));
    const guides = all.filter((el) => !selectedIds.includes(el.dataset.itemId ?? ""));
    setSelectedElements((previous) => (same(previous, selected) ? previous : selected));
    setGuideElements((previous) => (same(previous, guides) ? previous : guides));
    // Selecto keeps a list of its own; told what the page selected (Escape, Cmd-A, a group taken
    // whole), it reports a Shift-click as the addition or removal it is.
    selectoRef.current?.setSelectedTargets(selected);
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
      if (!inSelection) selectMany(withGroupMembers([pageId]));
      // The menu acts on what the right-click selected: the selection it fell in, or the item with
      // its group, since a group is selected whole. The ids are fixed here, because the menu's
      // actions run after the selection has changed and would otherwise read the one before it.
      const groupMates = item.group ? (activeSheet?.items ?? []).filter((other) => other.group === item.group).map(({ id }) => id) : [item.id];
      const ids = inSelection && selectedTemplateIds.length > 1 ? selectedTemplateIds : groupMates;
      const many = ids.length > 1;
      const plotLike = isPlotLikeRecipe(item.recipe);
      const items: MenuEntry[] = [
        { label: many ? t("Duplicate {n} items", { n: ids.length }) : t("Duplicate"), onClick: () => duplicateItems(ids) },
        { label: t("Bring to front"), onClick: () => restackItems(ids, "front") },
        { label: t("Bring forward"), onClick: () => restackItems(ids, "forward") },
        { label: t("Send backward"), onClick: () => restackItems(ids, "backward") },
        { label: t("Send to back"), onClick: () => restackItems(ids, "back") },
        { label: item.locked ? t("Unlock") : t("Lock"), onClick: () => setLocked(ids, !item.locked) },
        ...(inSelection && selectedUnitCount > 1 ? [{ label: t("Group"), onClick: groupSelected } satisfies MenuEntry] : []),
        ...(item.group ? [{ label: t("Ungroup"), onClick: () => mutateActiveSheet((sheet) => ungroupItems(sheet, ids)) } satisfies MenuEntry] : []),
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
        // With a selection on the page, the menu on blank paper offers what the selection's own menu does for grouping, as Illustrator's does.
        ...(selectedUnitCount > 1 ? [{ label: t("Group"), onClick: groupSelected } satisfies MenuEntry] : []),
        ...(selectedItems.some((item) => item.group) ? [{ label: t("Ungroup"), onClick: ungroupSelected } satisfies MenuEntry] : []),
        { label: t("Select all"), disabled: !currentPage.items.length, onClick: () => selectMany(currentPage.items.filter((item) => !lockedTemplateIds.has(item.templateId)).map(({ id }) => id)) },
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
  /**
   * The selected plot's pool: the files given, in file order, or none. The reference file stays
   * while it is in the pool; otherwise the first pooled file takes over, with the population
   * carried into its tree as the FCS select carries it.
   */
  const setSelectedPool = (sampleIds: readonly string[] | null) =>
    updateSelectedRecipe((recipe) => {
      if (recipe.kind !== "biplot" && recipe.kind !== "histogram") return recipe;
      const ordered = sampleIds ? files.filter((file) => sampleIds.includes(file.id)).map((file) => file.id) : [];
      if (!ordered.length) {
        const { pool: _pool, ...rest } = recipe;
        return rest;
      }
      const referenceId = ordered.includes(recipe.sampleId) ? recipe.sampleId : ordered[0];
      let populationId = recipe.populationId;
      if (referenceId !== recipe.sampleId) {
        const from = samples.find(({ id }) => id === recipe.sampleId);
        const target = samples.find(({ id }) => id === referenceId);
        if (from && target) {
          const mapped = resolveFigurePopulation({ hierarchyId: from.tree.id, populationId, label: "" }, target.tree, trees);
          populationId = mapped.id ?? target.tree.root_population_id ?? populationId;
        }
      }
      return { ...recipe, sampleId: referenceId, populationId, pool: { sampleIds: ordered } };
    });
  /** What the selected plot's pool holds and leaves out, for the inspector. */
  const selectedPoolReport = useMemo<PoolReport | null>(() => {
    const recipe = selectedItem?.recipe;
    if (!recipe || !isPlotLikeRecipe(recipe) || recipe.kind === "strategy" || !recipe.pool) return null;
    const templateTreeId = selectedPageItem?.templateSampleId ? samples.find(({ id }) => id === selectedPageItem.templateSampleId)?.tree.id : undefined;
    const { members, leftOut } = resolvePoolMembers(recipe, samples, trees, templateTreeId);
    const omittedGates = recipe.kind === "biplot" && recipe.yChannel && members.length > 1
      ? pooledGateAgreement(trees, members.map((member) => member.tree.id), recipe.xChannel, recipe.yChannel).omitted.map((gate) => gate.name)
      : [];
    return { pooled: members.length, total: recipe.pool.sampleIds.length, leftOut, omittedGates };
  }, [selectedItem, selectedPageItem, samples, trees]);

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
      // Copies of a group's members make a group of their own.
      const copiedGroups = new Map<string, string>();
      for (const id of ids) {
        const source = sheet.items.find((item) => item.id === id);
        if (!source) continue;
        const copyId = crypto.randomUUID();
        created.push(copyId);
        const frame = frames?.[id] ?? { x: source.x + 20, y: source.y + 20, width: source.width, height: source.height };
        const group = source.group ? copiedGroups.get(source.group) ?? crypto.randomUUID() : undefined;
        if (source.group && group) copiedGroups.set(source.group, group);
        sheet.items.push({ ...source, ...frame, id: copyId, locked: false, z: ++z, recipe: { ...source.recipe }, ...(group ? { group } : {}) });
      }
    });
    if (created.length) selectMany(created);
    return created;
  };
  const nudgeItems = (ids: readonly string[], dx: number, dy: number) => {
    mutateActiveSheet((sheet) => {
      for (const item of sheet.items) {
        if (!ids.includes(item.id) || item.locked) continue;
        item.x += dx;
        item.y += dy;
      }
    });
  };
  /**
   * Move items to the top or the bottom of the stack, or one step up or down past the nearest
   * item that is not moving; z is then the stacking order 0…n−1.
   */
  const restackItems = (ids: readonly string[], where: "front" | "back" | "forward" | "backward") => {
    mutateActiveSheet((sheet) => {
      const ordered = [...sheet.items].sort((a, b) => a.z - b.z);
      const moving = ordered.filter((item) => ids.includes(item.id));
      const rest = ordered.filter((item) => !ids.includes(item.id));
      let next: LayoutItem[];
      if (where === "front") next = [...rest, ...moving];
      else if (where === "back") next = [...moving, ...rest];
      else {
        next = ordered;
        // From the top down for forward, the bottom up for backward, so a block of moving items
        // passes one still item together rather than leapfrogging itself.
        const indices = next.map((_, index) => index);
        if (where === "forward") indices.reverse();
        for (const index of indices) {
          const other = where === "forward" ? index + 1 : index - 1;
          if (!ids.includes(next[index].id) || other < 0 || other >= next.length || ids.includes(next[other].id)) continue;
          [next[index], next[other]] = [next[other], next[index]];
        }
      }
      next.forEach((entry, z) => {
        entry.z = z;
      });
    });
  };
  /** Cmd-G: the selected items become one group, and stay selected. */
  const groupSelected = () => {
    if (selectedUnitCount < 2) return;
    mutateActiveSheet((sheet) => { groupItems(sheet, selectedTemplateIds); });
  };
  /** Shift-Cmd-G: every group among the selected items is dissolved; the items stay selected. */
  const ungroupSelected = () => {
    if (!selectedItems.some((item) => item.group)) return;
    mutateActiveSheet((sheet) => ungroupItems(sheet, selectedTemplateIds));
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
    mutateActiveSheet((sheet) => distributeItems(sheet, selectedTemplateIds.filter((id) => !sheet.items.find((item) => item.id === id)?.locked), how));
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
  /** Put elements back where their items are: what a cancelled or negligible drag leaves. */
  const restoreFrames = (targets: readonly Element[]) => {
    for (const el of targets) {
      const item = currentPage.items.find((candidate) => candidate.id === (el as HTMLElement).dataset.itemId);
      if (item) Object.assign((el as HTMLElement).style, { left: `${item.x}px`, top: `${item.y}px`, width: `${item.width}px`, height: `${item.height}px` });
    }
  };
  const restoreRef = useRef(restoreFrames);
  restoreRef.current = restoreFrames;
  /** The gesture under way, so Escape can cancel it and its end can tell a cancelled drag from a finished one. */
  const gestureRef = useRef<{ targets: Element[]; ghosts?: HTMLElement[]; cancelled: boolean } | null>(null);
  const beginGesture = (targets: Element[], ghosts?: HTMLElement[]) => {
    const gesture = { targets, ghosts, cancelled: false };
    gestureRef.current = gesture;
    // A gesture ends when the pointer is released, whether or not Moveable says so: its end
    // event does not come when the targets changed under it (a Shift-click handed back to
    // Selecto), and a record left behind would swallow the next Escape.
    const onRelease = () => {
      window.removeEventListener("mouseup", onRelease, true);
      window.removeEventListener("touchend", onRelease, true);
      window.setTimeout(() => {
        if (gestureRef.current !== gesture) return;
        gestureRef.current = null;
        removeGhosts(gesture.ghosts);
      }, 0);
    };
    window.addEventListener("mouseup", onRelease, true);
    window.addEventListener("touchend", onRelease, true);
  };
  /**
   * The end of a drag or resize: a cancelled one, or one that moved less than 3 px (a press with a
   * wobble, as tldraw and svg-edit read it), puts the elements back and is not an edit.
   */
  const endGesture = (targets: readonly Element[], lastEvent: { dist?: number[] } | null | undefined, isDrag: boolean, commit: () => void) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    removeGhosts(gesture?.ghosts);
    const dist = lastEvent?.dist;
    const moved = !dist || Math.hypot(dist[0] ?? 0, dist[1] ?? 0) >= 3;
    if (gesture?.cancelled || !isDrag || !moved) restoreFrames(targets);
    else commit();
  };
  const applyDrag = (e: OnDrag) => {
    e.target.style.left = `${e.left}px`;
    e.target.style.top = `${e.top}px`;
    // With each item in its own frame, the others in the selection follow the one dragged.
    const companions = e.datas?.companions as { el: HTMLElement; left: number; top: number }[] | undefined;
    if (!companions?.length) return;
    const dx = e.left - (e.datas.startLeft as number);
    const dy = e.top - (e.datas.startTop as number);
    for (const { el, left, top } of companions) {
      el.style.left = `${left + dx}px`;
      el.style.top = `${top + dy}px`;
    }
  };
  /** The elements a drag moves: the one pressed, and with own frames the rest of the selection. */
  const dragTargets = (e: { target: HTMLElement | SVGElement; datas: Record<string, unknown> }): (HTMLElement | SVGElement)[] => {
    const companions = e.datas?.companions as { el: HTMLElement }[] | undefined;
    return [e.target, ...(companions ?? []).map(({ el }) => el)];
  };
  const startDrag = (e: OnDragStart) => {
    e.datas.alt = !!e.inputEvent?.altKey;
    const target = e.target as HTMLElement;
    const others = ownFrames ? movableRef.current.filter((el) => el !== target) : [];
    e.datas.startLeft = parseFloat(target.style.left) || 0;
    e.datas.startTop = parseFloat(target.style.top) || 0;
    e.datas.companions = others.map((el) => ({ el, left: parseFloat(el.style.left) || 0, top: parseFloat(el.style.top) || 0 }));
    const targets = dragTargets(e);
    beginGesture(targets, e.datas.alt ? leaveGhosts(targets) : undefined);
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
    if (movableElements.some((el) => el === target || el.contains(target))) {
      e.stop();
      // Each item in its own frame drags itself, as a single selection does.
      if (movableElements.length > 1 && !ownFrames) {
        moveable?.dragStart(e.inputEvent);
        // Moveable's own click does not fire for a drag it was handed, so a press that does not
        // move is given back to Selecto as the click it was: Shift takes the item out of the
        // selection, a plain click takes it alone (a group stays whole).
        const down = e.inputEvent as MouseEvent;
        const onUp = (up: MouseEvent) => {
          window.removeEventListener("mouseup", onUp);
          if (Math.hypot(up.clientX - down.clientX, up.clientY - down.clientY) < 4) selectoRef.current?.clickTarget(down, target);
        };
        window.addEventListener("mouseup", onUp);
      }
    }
  };
  const onSelectEnd = (e: OnSelectEnd) => {
    // A press on an item takes it, a locked one included, so it can be unlocked (Selecto reports
    // a press as a click or as a drag start); a marquee passes over locked items, as it does in
    // the vector editors.
    const pressed = e.isClick || e.isDragStart;
    // A group is taken whole: a member selected brings the rest, a member taken out (Shift-click)
    // takes the rest out too.
    const removedGroups = new Set((e.removed ?? []).map((el) => groupOfPageId((el as HTMLElement).dataset.itemId ?? "")).filter(Boolean));
    const ids = withGroupMembers(
      e.selected
        .map((el) => (el as HTMLElement).dataset.itemId ?? "")
        .filter((id) => id && (pressed || !lockedTemplateIds.has(templateIdOf(id)))),
    ).filter((id) => !removedGroups.has(groupOfPageId(id)));
    selectMany(ids);
    // Pressing an unselected item and moving at once selects it and drags it. Only a real press
    // is handed on: the click Selecto is handed back after a press on a multi-selection reports
    // itself as a drag start too, and a drag begun from it would start after the pointer was
    // released and follow the pointer until the next release. A locked item, or a text being
    // edited, is selected but not dragged, so no drag waits for a target change that will not come.
    if (e.isDragStart && !e.isClick) {
      const movable = ids.filter((id) => !lockedTemplateIds.has(templateIdOf(id)) && id !== editingTextId);
      if (!movable.length) return;
      e.inputEvent?.preventDefault?.();
      handedOffRef.current = true;
      const clear = () => { handedOffRef.current = false; };
      window.setTimeout(() => window.addEventListener("mousedown", clear, { capture: true, once: true }), 0);
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
        composed.push(...composeSheetPages(canvas, activeSheet, { zoom, crop: exportCrop ? { paddingMm: exportPaddingMm } : undefined }));
      }
      await writeComposedPages(composed, activeSheet, exportFormat);
      onExported?.();
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
    if (event.key === "Enter" && selectedIds.length === 1) {
      const item = currentPage.items.find((candidate) => candidate.id === selectedIds[0]);
      if (item?.recipe.kind === "text") {
        event.preventDefault();
        setEditingTextId(item.id);
        return;
      }
    }
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
    // Cmd-] and Cmd-[ one step, with Shift to the front or the back, as in the vector editors.
    if (meta && (event.key === "]" || event.key === "[")) {
      event.preventDefault();
      restackItems(selectedTemplateIds, event.key === "]" ? (event.shiftKey ? "front" : "forward") : (event.shiftKey ? "back" : "backward"));
      return;
    }
    if (meta && event.key.toLowerCase() === "g") {
      event.preventDefault();
      if (event.shiftKey) ungroupSelected();
      else groupSelected();
      return;
    }
    // Shift-Cmd-L, Figma's key: the browser keeps Cmd-L for its address bar and Cmd-2 for its tabs.
    if (meta && event.shiftKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      setLocked(selectedTemplateIds, !selectionLocked);
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

  // Undo and redo belong to the layout while this tab is shown, wherever the keyboard is: after a
  // toolbar or inspector click the page no longer has it, and the app's own listener would undo
  // the last gating edit instead. Taken on the window in the capture phase, so it comes first; a
  // field keeps its own undo.
  const historyRef = useRef({ undo, redo });
  historyRef.current = { undo, redo };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Escape while a drag or resize is under way cancels it: the elements go back and nothing is
      // committed, as in Illustrator and Figma.
      if (event.key === "Escape" && gestureRef.current) {
        const gesture = gestureRef.current;
        gesture.cancelled = true;
        event.preventDefault();
        event.stopPropagation();
        restoreRef.current(gesture.targets);
        removeGhosts(gesture.ghosts);
        gesture.ghosts = undefined;
        stopMoveableDrags(moveableRef.current);
        return;
      }
      const action = historyShortcutAction(event);
      if (!action) return;
      if ((event.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === "undo") historyRef.current.undo();
      else historyRef.current.redo();
    };
    // Moveable's drag outlives a window blur (Cmd-Tab); the ghost of an Option-drag is dropped then.
    const onBlur = () => { const gesture = gestureRef.current; if (gesture) { removeGhosts(gesture.ghosts); gesture.ghosts = undefined; } };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

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
          // A toolbar click does not take the keyboard from the page, so Escape, Delete, the
          // arrows and undo still act on the page afterwards, with or without a selection.
          if ((event.target as HTMLElement).closest("button")) event.preventDefault();
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
            <button key={how} className="gl-mini-btn" type="button" onClick={() => spread(how)} disabled={selectedUnitCount < 3 || preview} title={t(title)}>{t(label)}</button>
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
                  <strong>{selectionGrouped ? t("{count} items selected, one group", { count: selectedItems.length }) : t("{count} items selected", { count: selectedItems.length })}</strong>
                  <div className="gl-layout-item-actions">
                    {selectedUnitCount > 1 && <button type="button" className="gl-mini-btn" onClick={groupSelected} title={t("One group: selected, moved, aligned and distributed together (Cmd-G)")}>{t("Group")}</button>}
                    {selectedItems.some((item) => item.group) && <button type="button" className="gl-mini-btn" onClick={ungroupSelected} title={t("Dissolve the group; the items stay where they are (Shift-Cmd-G)")}>{t("Ungroup")}</button>}
                    <button type="button" className="gl-mini-btn" onClick={() => duplicateItems(selectedTemplateIds)} title={t("Copies of every selected item, 20 px down and right (Cmd-D)")}>{t("Duplicate")}</button>
                    <button type="button" className="gl-mini-btn" onClick={() => restackItems(selectedTemplateIds, "front")} title={t("Draw the selected items over every other")}>{t("Bring to front")}</button>
                    <button type="button" className="gl-mini-btn" onClick={() => restackItems(selectedTemplateIds, "back")} title={t("Draw the selected items under every other")}>{t("Send to back")}</button>
                    <button type="button" className="gl-mini-btn" onClick={() => setLocked(selectedTemplateIds, !selectionLocked)} title={t("Lock or unlock the selected items")}>{selectionLocked ? t("Unlock") : t("Lock")}</button>
                    <button type="button" className="gl-mini-btn" onClick={() => removeItems(selectedTemplateIds)} title={t("Remove the selected items (Delete)")}>{t("Remove")}</button>
                  </div>
                  <p className="gl-hint">{t("Align and distribute them with the toolbar; drag any of them to move them together; Cmd-G makes them one group.")}</p>
                </div>
              )}
              {!selectedItems.length && (
                <p className="gl-hint">
                  {t("Click an item to select it, drag empty page to select several, Shift-click to add or remove. Drag to move, Shift holds the direction; drag a corner handle or an edge to resize, Shift keeps the proportions, Option resizes from the centre; Cmd turns snapping off; Option-drag copies. Delete removes, arrows nudge (Shift: 10 px), Cmd-D duplicates, Cmd-A selects all, Cmd-] and Cmd-[ bring forward and send backward (Shift: to the front or back), Cmd-G groups and Shift-Cmd-G ungroups, Shift-Cmd-L locks, Cmd-Z undoes.")}
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
                      {!poolOf(selectedItem.recipe) && (
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
                      )}
                      {(selectedItem.recipe.kind === "biplot" || selectedItem.recipe.kind === "histogram") && (
                        <label className="gl-check" title={t("Draw the events of several files on this plot, as the Gating tab pools the checked files; a gate is drawn where every pooled file has it alike, with the pooled percentage")}>
                          <input
                            type="checkbox"
                            checked={!!selectedItem.recipe.pool}
                            onChange={(event) => {
                              if (!event.target.checked) {
                                setSelectedPool(null);
                                return;
                              }
                              // The pool starts as the checked files when they include this plot's file, else the file alone.
                              const own = selectedItem.recipe.kind === "biplot" || selectedItem.recipe.kind === "histogram" ? selectedItem.recipe.sampleId : "";
                              setSelectedPool(checkedSampleIds.includes(own) ? checkedSampleIds : [own]);
                            }}
                          />
                          {t("Pool files")}
                        </label>
                      )}
                      {(selectedItem.recipe.kind === "biplot" || selectedItem.recipe.kind === "histogram") && selectedItem.recipe.pool && (
                        <LayoutPoolPicker
                          files={files}
                          pool={selectedItem.recipe.pool.sampleIds}
                          checkedSampleIds={checkedSampleIds}
                          groups={groups}
                          fileGroups={fileGroups}
                          report={selectedPoolReport}
                          onChange={setSelectedPool}
                        />
                      )}
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
                      {selectedItem.recipe.kind === "strategy" && selectedItem.recipe.populationIds?.length && (
                        <>
                          <p className="gl-hint">
                            {t("{count} populations; the grid follows the live gates", { count: selectedItem.recipe.populationIds.length })}
                          </p>
                          <label className="gl-field-inline" title={t("Tree: a column per depth and a row per leaf. Wrapped: the tree walked depth first and wrapped into rows of the columns beside.")}>
                            {t("Layout")}
                            <select
                              value={selectedItem.recipe.layout ?? "tree"}
                              onChange={(event) => updateSelectedRecipe((recipe) => recipe.kind === "strategy" ? { ...recipe, layout: event.target.value === "flow" ? "flow" : "tree" } : recipe)}
                            >
                              <option value="tree">{t("Tree")}</option>
                              <option value="flow">{t("Wrapped")}</option>
                            </select>
                          </label>
                          {(selectedItem.recipe.layout ?? "tree") === "flow" && (
                            <label className="gl-field-inline">
                              {t("Columns")}
                              <NumberField min={1} max={24} integer value={selectedItem.recipe.columns ?? 4} onCommit={(columns) => updateSelectedRecipe((recipe) => recipe.kind === "strategy" ? { ...recipe, columns } : recipe)} />
                            </label>
                          )}
                          <label className="gl-check" title={t("An arrow from each gate to the panel of the population it makes, through the gutters")}>
                            <input
                              type="checkbox"
                              checked={selectedItem.recipe.showArrows !== false}
                              onChange={(event) => updateSelectedRecipe((recipe) => recipe.kind === "strategy" ? { ...recipe, showArrows: event.target.checked } : recipe)}
                            />
                            {t("Arrows")}
                          </label>
                          {selectedItem.recipe.showArrows !== false && (
                            <>
                              <label className="gl-field-inline" title={t("The arrows' colour; unticked, each takes its gate's")}>
                                <input
                                  type="checkbox"
                                  checked={!!selectedItem.recipe.arrowColor}
                                  onChange={(event) => updateSelectedRecipe((recipe) => recipe.kind === "strategy" ? { ...recipe, arrowColor: event.target.checked ? "#444444" : undefined } : recipe)}
                                />
                                {t("One colour")}
                                {selectedItem.recipe.arrowColor && (
                                  <input
                                    type="color"
                                    value={selectedItem.recipe.arrowColor}
                                    onChange={(event) => updateSelectedRecipe((recipe) => recipe.kind === "strategy" ? { ...recipe, arrowColor: event.target.value } : recipe)}
                                  />
                                )}
                              </label>
                              <label className="gl-field-inline" title={t("Where an arrow leaves its panel: level with the gate's label, or with the centre of the gate itself")}>
                                {t("Arrows from")}
                                <select
                                  value={selectedItem.recipe.arrowAnchor ?? "label"}
                                  onChange={(event) => updateSelectedRecipe((recipe) => recipe.kind === "strategy" ? { ...recipe, arrowAnchor: event.target.value === "gate" ? "gate" : undefined } : recipe)}
                                >
                                  <option value="label">{t("Gate label")}</option>
                                  <option value="gate">{t("Gate centre")}</option>
                                </select>
                              </label>
                              <label className="gl-field-inline">
                                {t("Arrow width")}
                                <NumberField min={0.5} max={6} step={0.25} value={selectedItem.recipe.arrowWidth ?? 1.5} onCommit={(arrowWidth) => updateSelectedRecipe((recipe) => recipe.kind === "strategy" ? { ...recipe, arrowWidth } : recipe)} />
                              </label>
                            </>
                          )}
                        </>
                      )}
                      {selectedItem.recipe.kind === "strategy" && !selectedItem.recipe.populationIds?.length && (
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
                        <label className="gl-check" title={iteration.mode === "populations" ? t("Drawn once per population of the iteration, for that population; unticked, it shows its own population on every page") : iteration.mode === "metadata" ? t("Drawn once per value of {column}, pooling that value's files; unticked, it shows its own files on every page", { column: iteration.column ?? "" }) : t("Drawn once per file of the iteration, for that file; unticked, it shows this file on every page")}>
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
              <label className="gl-field-inline">
                <input type="checkbox" checked={exportCrop} onChange={(event) => setExportCrop(event.target.checked)} />
                {t("Crop to content")}
              </label>
              {exportCrop && (
                <label className="gl-field-inline">
                  {t("Padding (mm)")}
                  <NumberField min={0} max={50} step={0.5} aria-label={t("Padding (mm)")} value={exportPaddingMm} onCommit={setExportPaddingMm} />
                </label>
              )}
              <button className="gl-mini-btn" type="button" onClick={() => void exportSheet()} disabled={exporting || !activeSheet.items.length}>
                {exporting ? t("Exporting…") : t("Export sheet")}
              </button>
              <p className="gl-hint">
                {exportCrop
                  ? t("The export is cut down to the items on each page plus the padding, so a figure comes out without the paper around it; a grid of pages is written as one PDF page each, or one SVG or PNG file each in a zip. The data layer is drawn at the resolution above.")
                  : t("The export is the page at its physical size; a grid of pages is written as one PDF page each, or one SVG or PNG file each in a zip. The data layer is drawn at the resolution above and anything beyond the pages is cut off.")}
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
                  onChange={(event) => {
                    const mode = event.target.value;
                    if (mode === "metadata") {
                      // The source of a file iteration names one value; here every value is a unit, so it falls back to the checked files.
                      const column = iteration.column && metadataColumns.includes(iteration.column) ? iteration.column : metadataColumns[0] ?? "";
                      setIteration({ ...iteration, mode: "metadata", column, source: iteration.source.kind === "metadata" ? { kind: "checked" } : iteration.source });
                      return;
                    }
                    setIteration({ ...iteration, mode: mode === "files" ? "files" : mode === "populations" ? "populations" : "off" });
                  }}
                >
                  <option value="off">{t("Once")}</option>
                  <option value="files">{t("Once per file")}</option>
                  <option value="populations">{t("Once per population")}</option>
                  <option value="metadata" disabled={!metadataColumns.length}>{t("Once per value of a metadata column")}</option>
                </select>
              </label>
              {iteration.mode === "metadata" && (
                <label className="gl-field-inline">
                  {t("Column")}
                  <select value={iteration.column ?? ""} onChange={(event) => setIteration({ ...iteration, column: event.target.value })}>
                    {metadataColumns.map((column) => (
                      <option key={column} value={column}>{column}</option>
                    ))}
                  </select>
                </label>
              )}
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
                  {(iteration.mode === "files" || iteration.mode === "metadata") && (
                  <label className="gl-field-inline">
                    {t("Files")}
                    <select value={sourceKey} onChange={(event) => setIteration({ ...iteration, source: sourceFromKey(event.target.value) })}>
                      <option value="checked">{t("Checked files")}</option>
                      <option value="all">{t("All files")}</option>
                      {groups.map((group) => (
                        <option key={group.id} value={`group:${group.id}`}>{t("Group {name}", { name: group.name })}</option>
                      ))}
                      {iteration.mode === "files" && metadataColumns.flatMap((column) =>
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
                      <option value="page-per-unit">{iteration.mode === "populations" ? t("One page per population") : iteration.mode === "metadata" ? t("One page per value") : t("One page per file")}</option>
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
                      : iteration.mode === "metadata"
                        ? t("{values} values of {column} over {files} files → {pages} pages. Items marked “Follows the iteration” pool the files of each value; the others repeat. Text and titles may use {sample} (the value), {meta:column}, {file} (how many files), {n} and {N}; a plot title may also use {population} and {count}.", { values: units.length, column: iteration.column ?? "", files: units.reduce((total, unit) => total + (unit.sampleIds?.length ?? 0), 0), pages: Math.max(1, pages.length) })
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
                onTextChange={(text, contentHeight) => {
                  // A block left with no words is removed, as the editors remove an empty text; undo brings it back.
                  if (!text.trim()) { removeItems([item.templateId]); return; }
                  mutateActiveSheet((sheet) => {
                    const target = sheet.items.find(
                      (candidate) => candidate.id === item.templateId,
                    );
                    if (target?.recipe.kind !== "text") return;
                    target.recipe.text = text;
                    // A block grows to show every line it was given; it never shrinks on its own.
                    if (contentHeight > 0) target.height = Math.max(target.height, Math.ceil(contentHeight) + 4);
                  });
                }}
                onTextFocus={() => { if (!selectedIds.includes(item.id) || selectedIds.length > 1) setSelectedIds([item.id]); }}
                textEditing={editingTextId === item.id}
                onTextEditStart={() => { setSelectedIds([item.id]); setEditingTextId(item.id); }}
                // Double-click on a member of a selected group takes the member alone, as Excalidraw and Penpot do.
                onIsolate={item.group && selectedIds.includes(item.id) && selectedIds.length > 1 ? () => setSelectedIds([item.id]) : undefined}
                // The block stays selected and the page takes the keyboard back.
                onTextEditEnd={() => { setEditingTextId((current) => (current === item.id ? null : current)); canvasRef.current?.focus({ preventScroll: true }); }}
              />
            ))}
            {!preview && (
              <Moveable
                ref={moveableRef}
                target={movableElements.length === 1 ? movableElements[0] : movableElements}
                zoom={1 / zoom}
                origin={false}
                checkInput
                // The overlay Moveable draws over a group lets presses through, so a member's
                // editor can take focus and a click on a member can select it alone.
                passDragArea
                draggable
                resizable
                // Moveable measures its targets only when told; an undo, a nudge, an alignment or an
                // inspector edit moves an item by its style, so the targets are watched for that.
                useMutationObserver
                useResizeObserver
                keepRatio={modifiers.shift}
                throttleDragRotate={modifiers.shift ? 45 : 0}
                snappable={!modifiers.meta}
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
                individualGroupable={ownFrames}
                // Each item's frame measures from its wrapper's container, which the wrapper has not
                // yet attached when the frames first mount; naming it (the page, where the frame is
                // drawn anyway) keeps the first measurement from failing.
                container={ownFrames ? pageEl : undefined}
                onDragStart={startDrag}
                onDrag={applyDrag}
                onDragEnd={(e: OnDragEnd) => { const targets = dragTargets(e); endGesture(targets, e.lastEvent, e.isDrag, () => commitFrames(targets, !!e.datas.alt)); }}
                onDragGroupStart={(e: OnDragGroupStart) => { e.datas.alt = !!e.inputEvent?.altKey; beginGesture([...(e.targets ?? [])], e.datas.alt ? leaveGhosts(e.targets ?? []) : undefined); }}
                onDragGroup={(e: OnDragGroup) => e.events.forEach(applyDrag)}
                onDragGroupEnd={(e: OnDragGroupEnd) => endGesture(e.targets, e.lastEvent, e.isDrag, () => commitFrames(e.targets, !!e.datas.alt))}
                // Option held as a handle is taken: the resize keeps the centre where it is.
                onResizeStart={(e: OnResizeStart) => { beginGesture([e.target]); if (e.inputEvent?.altKey) e.setFixedDirection([0, 0]); }}
                onResize={applyResize}
                onResizeEnd={(e: OnResizeEnd) => endGesture([e.target], e.lastEvent, e.isDrag, () => commitFrames([e.target], false))}
                onResizeGroupStart={(e: OnResizeGroupStart) => { beginGesture([...(e.targets ?? [])]); if (e.inputEvent?.altKey) e.events.forEach((event) => event.setFixedDirection([0, 0])); }}
                onResizeGroup={(e: OnResizeGroup) => e.events.forEach(applyResize)}
                onResizeGroupEnd={(e: OnResizeGroupEnd) => endGesture(e.targets, e.lastEvent, e.isDrag, () => commitFrames(e.targets, false))}
                // A press on a selected item is Moveable's, for the drag; a click that did not move is
                // handed back to Selecto, so Shift-click takes the item out again and a click on one
                // member of a selected group selects that member alone (a group re-selects whole).
                // With own frames a plain click on one of several selected items takes it alone.
                onClick={(e: OnClick) => {
                  if (handedOffRef.current) { handedOffRef.current = false; return; }
                  if (e.inputEvent?.shiftKey || ownFrames) selectoRef.current?.clickTarget(e.inputEvent, e.inputTarget);
                }}
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

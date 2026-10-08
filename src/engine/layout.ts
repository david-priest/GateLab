import { normalizeProportionsSettings, type ProportionsSettings } from "./proportionsSettings";

export const LAYOUT_WORKSPACE_VERSION = 2 as const;

export type LayoutDisplayMode = "scatter" | "pseudocolor" | "contour";

export type LayoutGateLabels = "name-percent" | "percent" | "number" | "name" | "none";
export const LAYOUT_GATE_LABELS: readonly LayoutGateLabels[] = ["name-percent", "percent", "number", "name", "none"];

/** How a sheet's plots are drawn. The sheet sets it; a plot or strategy may override any part. */
export interface LayoutPlotStyle {
  pointSize: number;
  pointAlpha: number;
  /** Events drawn per plot; counts and gates use every event. */
  maxEvents: number;
  /** The outermost contour, as a percentage of the peak density. */
  contourThreshold: number;
  contourLevels: number;
  /** Density smoothing; 0 chooses a bandwidth from the data. */
  kdeBandwidth: number;
  gateLineWidth: number;
  /** Black gates and labels, for print. */
  pubStyle: boolean;
  /** What a gate's label says. */
  gateLabels: LayoutGateLabels;
  histLineWidth: number;
  histFill: boolean;
  histFillAlpha: number;
  fontTick: number;
  fontAxis: number;
  fontTitle: number;
  fontGate: number;
}

export const DEFAULT_LAYOUT_STYLE: Readonly<LayoutPlotStyle> = {
  pointSize: 1.1,
  pointAlpha: 0.4,
  maxEvents: 50000,
  contourThreshold: 5,
  contourLevels: 10,
  kdeBandwidth: 0,
  gateLineWidth: 1.5,
  pubStyle: false,
  gateLabels: "name-percent",
  histLineWidth: 1.8,
  histFill: true,
  histFillAlpha: 0.22,
  fontTick: 9,
  fontAxis: 11,
  fontTitle: 11,
  fontGate: 9,
};

export type LayoutStyleNumber = Exclude<keyof LayoutPlotStyle, "pubStyle" | "histFill" | "gateLabels">;

/** The range each numeric style field is kept within, on input and when a workspace is read. */
export const LAYOUT_STYLE_RANGES: Readonly<Record<LayoutStyleNumber, readonly [number, number]>> = {
  pointSize: [0.25, 6],
  pointAlpha: [0.05, 1],
  // High enough to draw every event of a pooled SCE (the HSCT object pools 951,880); the default
  // stays 50,000, and a plot drawn with millions of points repaints slowly. 0 means every event
  // (normalizeLayoutStyle keeps it), which the "All events" switch sets.
  maxEvents: [500, 5000000],
  contourThreshold: [0.5, 50],
  contourLevels: [2, 30],
  kdeBandwidth: [0, 10],
  gateLineWidth: [0.25, 6],
  histLineWidth: [0.25, 6],
  histFillAlpha: [0, 1],
  fontTick: [4, 40],
  fontAxis: [4, 40],
  fontTitle: [4, 40],
  fontGate: [4, 40],
};

/** A saved or edited style, field by field: known keys within their range, the rest dropped. */
export function normalizeLayoutStyle(value: unknown): Partial<LayoutPlotStyle> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const candidate = value as Record<string, unknown>;
  const out: Partial<LayoutPlotStyle> = {};
  for (const key of Object.keys(LAYOUT_STYLE_RANGES) as LayoutStyleNumber[]) {
    const raw = candidate[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    // An event cap of 0 is every event, as it is on the Gating tab; it is kept as 0, not raised
    // to the field's floor.
    if (key === "maxEvents" && raw === 0) {
      out[key] = 0;
      continue;
    }
    const [lo, hi] = LAYOUT_STYLE_RANGES[key];
    const whole = key === "maxEvents" || key === "contourLevels";
    out[key] = Math.min(hi, Math.max(lo, whole ? Math.round(raw) : raw));
  }
  if (typeof candidate.pubStyle === "boolean") out.pubStyle = candidate.pubStyle;
  if (typeof candidate.histFill === "boolean") out.histFill = candidate.histFill;
  if (LAYOUT_GATE_LABELS.includes(candidate.gateLabels as LayoutGateLabels)) out.gateLabels = candidate.gateLabels as LayoutGateLabels;
  return out;
}

/** The style a plot is drawn with: the defaults, under the sheet's settings, under the item's own. */
export function effectiveLayoutStyle(
  sheet: Pick<LayoutSheet, "style"> | null | undefined,
  recipe?: LayoutRecipe | null,
): LayoutPlotStyle {
  return {
    ...DEFAULT_LAYOUT_STYLE,
    ...(sheet?.style ?? {}),
    ...(recipe && isPlotLikeRecipe(recipe) ? recipe.style ?? {} : {}),
  };
}

export interface LayoutItemFrame {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  showFrame?: boolean;
  /** A locked item is not selected on the page, so it cannot be moved or resized by accident. */
  locked?: boolean;
  /** Items sharing a group id are one group: selected, moved, aligned and distributed together. */
  group?: string;
  /**
   * The item is drawn at width/zoom × height/zoom and scaled by zoom, so a plot shrinks or grows
   * as a whole, fonts and all, instead of being redrawn smaller. Fit content to page sets it.
   */
  zoom?: number;
}

export interface LayoutPlotRecipe {
  kind: "biplot" | "histogram";
  sampleId: string;
  populationId: string;
  xChannel: string;
  yChannel: string | null;
  displayMode: LayoutDisplayMode;
  /** The plot's own title; empty means the sheet's template. Placeholders are filled. */
  title?: string;
  /** The plot's name where it came from (an Illustration plot's), what {plot} says. */
  label?: string;
  /** This item's own settings; anything unset follows the sheet. */
  style?: Partial<LayoutPlotStyle>;
  /** Drawn once per unit when the sheet iterates; sampleId is then the template file. */
  iterated?: boolean;
  /**
   * The files whose events this plot pools, in file order, as a list: a plot records what was
   * drawn, so a file added later never joins it unasked. `sampleId` is one of them, the reference
   * file, whose tree, channels and population the plot is drawn with; a gate is drawn only where
   * every pooled file holds it alike, with the percentage pooled over them (engine/pooledPlot.ts).
   */
  pool?: { sampleIds: string[] };
}

export interface LayoutStrategyRecipe {
  kind: "strategy";
  sampleId: string;
  populationId: string;
  fullPath: boolean;
  displayMode: LayoutDisplayMode;
  /**
   * Several populations: the Strategy tab's multi-population grid (every step to each of them,
   * drawn once), rather than the strip to `populationId`. The ids are the tree's; a file on
   * another tree follows them by lineage. Absent: the strip.
   */
  populationIds?: string[];
  /** The grid's arrangement, as on the Strategy tab: a column per depth, or wrapped into rows of `columns`. */
  layout?: "tree" | "flow";
  columns?: number;
  /** Arrows from each gate to the panel of the population it makes, through the gutters; absent reads as on. */
  showArrows?: boolean;
  /** The arrows' colour; absent, each takes its gate's (dark under publication style). */
  arrowColor?: string;
  /** The arrows' line width, px; absent, 1.5. */
  arrowWidth?: number;
  /** Where an arrow leaves its panel: level with the gate's label (absent), or with the gate's centroid. */
  arrowAnchor?: "label" | "gate";
  /**
   * The size each panel was drawn at on the Strategy tab, px. The block is drawn at this size
   * and scaled as a whole to its frame, so it arrives as it was made and a resized frame keeps
   * its fonts, gates and gutters in proportion. Absent: 200.
   */
  plotSize?: number;
  /** Gate labels in bold, and the white backing behind a plain label (0 … 1), as on the Strategy tab. */
  gateLabelBold?: boolean;
  labelBackground?: number;
  title?: string;
  /** This item's own settings; anything unset follows the sheet. */
  style?: Partial<LayoutPlotStyle>;
  iterated?: boolean;
}

export type LayoutChartStatistic = "percent_of_parent" | "percent_of_total" | "count" | "median";
export type LayoutChartType = "bars" | "dots" | "box";

/**
 * A summary chart: one statistic of one population, per file, grouped by a metadata column,
 * with a rank test between the groups. It summarises across files, so it never iterates.
 */
export interface LayoutChartRecipe {
  kind: "chart";
  /** The file the population was chosen on; other files resolve it by provenance. */
  sampleId: string;
  populationId: string;
  statistic: LayoutChartStatistic;
  /** The channel, for a median. */
  channel?: string;
  /** The files drawn: those checked in the Samples pane, or every file. */
  files: "checked" | "all";
  /** A metadata column to group by; empty for one group. */
  groupBy: string;
  chartType: LayoutChartType;
  showPoints: boolean;
  test: boolean;
  title?: string;
}

/**
 * An Illustration figure as one block: the figure's spec and style as they were when it was
 * added, drawn by the Illustration tab's own panel builder and grid, so it looks on the page as
 * it does there. It holds its own files and populations, so it never iterates.
 */
export interface LayoutFigureRecipe {
  kind: "figure";
  /** The Illustration config, `figure` included; "Edit in Illustration" loads it back. */
  illustration: import("./workspace").IllustrationConfig;
  /** Which page of the figure's own paging to draw, 0-based. */
  page: number;
  title?: string;
}

export interface LayoutTextRecipe {
  kind: "text";
  text: string;
  fontSize: number;
  /**
   * The id of a plot on the sheet whose file and population fill this text's placeholders
   * ({file}, {sample}, {population}, {meta:column}, {popmeta:field}, {x}, {y}, {plot}, {count}),
   * so a heading reads what the plot beneath it shows. Unset: a plain text block.
   */
  readsFrom?: string;
  bold?: boolean;
}

/**
 * The Plotting tab's chart as one block: its settings as they were when it was added, drawn by
 * the tab's own model and chart, so it looks on the page as it does there. It holds its own
 * files and populations, so it never iterates.
 */
export interface LayoutProportionsRecipe {
  kind: "proportions";
  settings: ProportionsSettings;
  title?: string;
}

export type LayoutRecipe = LayoutPlotRecipe | LayoutStrategyRecipe | LayoutChartRecipe | LayoutFigureRecipe | LayoutProportionsRecipe | LayoutTextRecipe;

/** A plot or strategy block: the kinds bound to a file and a population, styled by the sheet, able to follow an iteration. */
export function isPlotLikeRecipe(recipe: LayoutRecipe): recipe is LayoutPlotRecipe | LayoutStrategyRecipe {
  return recipe.kind !== "text" && recipe.kind !== "chart" && recipe.kind !== "figure" && recipe.kind !== "proportions";
}

export interface LayoutItem extends LayoutItemFrame {
  recipe: LayoutRecipe;
}

/** A page in physical units: what is exported, and what the screen shows at 96 px per inch. */
export type LayoutPagePreset = "custom" | "a4" | "letter" | "journal-1" | "journal-2";
export type LayoutOrientation = "portrait" | "landscape";

export interface LayoutPage {
  preset: LayoutPagePreset;
  orientation: LayoutOrientation;
  /** The portrait size; a landscape page swaps them when measured. */
  widthMm: number;
  heightMm: number;
  marginMm: number;
  /** Resolution of the exported raster (PNG, and the image inside the PDF). */
  dpi: number;
  /** The sheet is a grid of pages, columns across and rows down, with page breaks between. */
  columns: number;
  rows: number;
}
export const MAX_PAGE_GRID = 10;

export const LAYOUT_PAGE_PRESETS: Record<
  Exclude<LayoutPagePreset, "custom">,
  { label: string; widthMm: number; heightMm: number; marginMm: number }
> = {
  a4: { label: "A4", widthMm: 210, heightMm: 297, marginMm: 15 },
  letter: { label: "US Letter", widthMm: 215.9, heightMm: 279.4, marginMm: 15 },
  "journal-1": { label: "Journal, one column (85 mm)", widthMm: 85, heightMm: 110, marginMm: 0 },
  "journal-2": { label: "Journal, two columns (170 mm)", widthMm: 170, heightMm: 220, marginMm: 0 },
};

/** CSS pixels per millimetre: the screen draws the page at 96 px per inch. */
export const SCREEN_PX_PER_MM = 96 / 25.4;
const MIN_PAGE_MM = 40;
const MAX_PAGE_MM = 2000;

export function mmToPx(mm: number): number {
  return Math.round(mm * SCREEN_PX_PER_MM);
}

export function pxToMm(px: number): number {
  return Math.round((px / SCREEN_PX_PER_MM) * 10) / 10;
}

/** The page as measured, with the orientation applied. */
export function pageSizeMm(page: LayoutPage): { widthMm: number; heightMm: number } {
  const landscape = page.orientation === "landscape";
  return {
    widthMm: landscape ? page.heightMm : page.widthMm,
    heightMm: landscape ? page.widthMm : page.heightMm,
  };
}

export function pageSizePx(page: LayoutPage): { width: number; height: number } {
  const { widthMm, heightMm } = pageSizeMm(page);
  return { width: mmToPx(widthMm), height: mmToPx(heightMm) };
}

/** The whole sheet: every page of the grid, in CSS pixels. */
export function sheetSizePx(page: LayoutPage): { width: number; height: number } {
  const one = pageSizePx(page);
  return { width: one.width * page.columns, height: one.height * page.rows };
}

/** The top-left corner of every page of the grid, in row-major order. */
export function pageOrigins(page: LayoutPage): { x: number; y: number; row: number; column: number }[] {
  const one = pageSizePx(page);
  const out: { x: number; y: number; row: number; column: number }[] = [];
  for (let row = 0; row < page.rows; row++)
    for (let column = 0; column < page.columns; column++)
      out.push({ x: column * one.width, y: row * one.height, row, column });
  return out;
}

/** A page from a preset; "custom" keeps the previous size. */
export function pageForPreset(
  preset: LayoutPagePreset,
  orientation: LayoutOrientation,
  previous?: LayoutPage,
): LayoutPage {
  if (preset === "custom") {
    return { ...(previous ?? defaultLayoutPage()), preset, orientation };
  }
  const spec = LAYOUT_PAGE_PRESETS[preset];
  return {
    preset,
    orientation,
    widthMm: spec.widthMm,
    heightMm: spec.heightMm,
    marginMm: spec.marginMm,
    dpi: previous?.dpi ?? 300,
    columns: previous?.columns ?? 1,
    rows: previous?.rows ?? 1,
  };
}

export function defaultLayoutPage(): LayoutPage {
  return {
    preset: "a4",
    orientation: "landscape",
    widthMm: LAYOUT_PAGE_PRESETS.a4.widthMm,
    heightMm: LAYOUT_PAGE_PRESETS.a4.heightMm,
    marginMm: LAYOUT_PAGE_PRESETS.a4.marginMm,
    dpi: 300,
    columns: 1,
    rows: 1,
  };
}

/** How a sheet iterates over files: which files, and how their pages or tiles are laid out. */
export interface LayoutIteration {
  /**
   * Once; once per file of `source`; once per population of the iterated items' file; or once
   * per value of a metadata column over the files of `source`, each value's files pooled on
   * the plots that follow.
   */
  mode: "off" | "files" | "populations" | "metadata";
  /** For "metadata": the column whose values are the units. */
  column?: string;
  source:
    | { kind: "checked" }
    | { kind: "all" }
    | { kind: "group"; groupId: string }
    | { kind: "metadata"; column: string; value: string };
  /** For "populations": every population of the tree but the root, or those under one. */
  populations?: { kind: "all" } | { kind: "branch"; populationId: string };
  arrangement:
    | { kind: "page-per-unit" }
    | { kind: "tiles"; rows: number; columns: number; order: "row-major" | "column-major"; gap: number };
}

export const DEFAULT_ITERATION: LayoutIteration = {
  mode: "off",
  source: { kind: "checked" },
  arrangement: { kind: "page-per-unit" },
};

const MAX_TILE_GRID = 12;

export function normalizeIteration(value: unknown): LayoutIteration {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_ITERATION };
  const c = value as Record<string, unknown>;
  const column = typeof c.column === "string" && c.column.trim() ? c.column.trim() : undefined;
  const mode: LayoutIteration["mode"] = c.mode === "files"
    ? "files"
    : c.mode === "populations"
      ? "populations"
      : c.mode === "metadata" && column
        ? "metadata"
        : "off";
  const p = (c.populations && typeof c.populations === "object" ? c.populations : null) as Record<string, unknown> | null;
  const populations: LayoutIteration["populations"] | undefined = !p
    ? undefined
    : p.kind === "branch" && typeof p.populationId === "string"
      ? { kind: "branch", populationId: p.populationId }
      : { kind: "all" };
  const s = (c.source && typeof c.source === "object" ? c.source : {}) as Record<string, unknown>;
  let source: LayoutIteration["source"] = { kind: "checked" };
  if (s.kind === "all") source = { kind: "all" };
  else if (s.kind === "group" && typeof s.groupId === "string") source = { kind: "group", groupId: s.groupId };
  else if (s.kind === "metadata" && typeof s.column === "string" && typeof s.value === "string") source = { kind: "metadata", column: s.column, value: s.value };
  const a = (c.arrangement && typeof c.arrangement === "object" ? c.arrangement : {}) as Record<string, unknown>;
  const clamp = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.min(MAX_TILE_GRID, Math.round(v))) : fallback;
  const arrangement: LayoutIteration["arrangement"] = a.kind === "tiles"
    ? {
        kind: "tiles",
        rows: clamp(a.rows, 2),
        columns: clamp(a.columns, 2),
        order: a.order === "column-major" ? "column-major" : "row-major",
        gap: typeof a.gap === "number" && Number.isFinite(a.gap) ? Math.max(0, Math.round(a.gap)) : 24,
      }
    : { kind: "page-per-unit" };
  return { mode, ...(mode === "metadata" ? { column } : {}), source, ...(populations ? { populations } : {}), arrangement };
}

export interface LayoutSheet {
  id: string;
  name: string;
  page: LayoutPage;
  /** Absent means off: the sheet is one static page. */
  iteration?: LayoutIteration;
  /** How the sheet's plots are drawn; anything unset is the default. */
  style?: Partial<LayoutPlotStyle>;
  /**
   * What the sheet's plots are titled, with placeholders (see layoutTitle.ts); a plot's own
   * title takes precedence. Absent or empty: what differs across the page.
   */
  titleTemplate?: string;
  /** The sheet in CSS pixels, kept equal to sheetSizePx(page): every page of the grid. */
  width: number;
  height: number;
  items: LayoutItem[];
}

export interface LayoutWorkspace {
  version: typeof LAYOUT_WORKSPACE_VERSION;
  activeSheetId: string;
  sheets: LayoutSheet[];
}

export function layoutItemMinimum(kind: LayoutRecipe["kind"]) {
  return kind === "text" ? { width: 24, height: 20 } : kind === "chart" ? { width: 160, height: 120 } : kind === "figure" || kind === "proportions" ? { width: 200, height: 150 } : { width: 140, height: 140 };
}

/** Set a sheet's page and the pixel size that follows from it. */
export function applyLayoutPage(sheet: LayoutSheet, page: LayoutPage): void {
  sheet.page = page;
  const size = sheetSizePx(page);
  sheet.width = size.width;
  sheet.height = size.height;
}

function finiteAtLeast(value: unknown, minimum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.round(value))
    : fallback;
}

function finiteBetween(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value * 10) / 10))
    : fallback;
}

function nonBlank(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function validDisplayMode(value: unknown): LayoutDisplayMode {
  return value === "scatter" || value === "contour" || value === "pseudocolor"
    ? value
    : "pseudocolor";
}

function normalizeRecipe(value: unknown): LayoutRecipe | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "text") {
    return {
      kind: "text",
      text: typeof candidate.text === "string" ? candidate.text : "Text",
      fontSize: finiteAtLeast(candidate.fontSize, 8, 18),
      ...(candidate.bold === true ? { bold: true } : {}),
      ...(typeof candidate.readsFrom === "string" && candidate.readsFrom ? { readsFrom: candidate.readsFrom } : {}),
    };
  }
  if (candidate.kind === "figure") {
    const illustration = candidate.illustration;
    if (!illustration || typeof illustration !== "object" || Array.isArray(illustration)) return null;
    const figure = (illustration as { figure?: unknown }).figure;
    if (!figure || typeof figure !== "object") return null;
    return {
      kind: "figure",
      illustration: illustration as LayoutFigureRecipe["illustration"],
      page: finiteAtLeast(candidate.page, 0, 0),
      title: typeof candidate.title === "string" ? candidate.title : undefined,
    };
  }
  if (candidate.kind === "proportions") {
    if (!candidate.settings || typeof candidate.settings !== "object" || Array.isArray(candidate.settings)) return null;
    return {
      kind: "proportions",
      settings: normalizeProportionsSettings(candidate.settings),
      title: typeof candidate.title === "string" ? candidate.title : undefined,
    };
  }
  if (candidate.kind === "chart") {
    const statistic = candidate.statistic;
    const chartType = candidate.chartType;
    return {
      kind: "chart",
      sampleId: nonBlank(candidate.sampleId, ""),
      populationId: nonBlank(candidate.populationId, ""),
      statistic: statistic === "percent_of_total" || statistic === "count" || statistic === "median" ? statistic : "percent_of_parent",
      ...(typeof candidate.channel === "string" && candidate.channel ? { channel: candidate.channel } : {}),
      files: candidate.files === "all" ? "all" : "checked",
      groupBy: typeof candidate.groupBy === "string" ? candidate.groupBy : "",
      chartType: chartType === "dots" || chartType === "box" ? chartType : "bars",
      showPoints: candidate.showPoints !== false,
      test: candidate.test !== false,
      title: typeof candidate.title === "string" ? candidate.title : undefined,
    };
  }
  if (candidate.kind === "strategy") {
    const populationIds = Array.isArray(candidate.populationIds)
      ? [...new Set((candidate.populationIds as unknown[]).filter((id): id is string => typeof id === "string" && id.trim() !== ""))]
      : [];
    const columns = Number(candidate.columns);
    const arrowWidth = Number(candidate.arrowWidth);
    const plotSize = Number(candidate.plotSize);
    const labelBackground = Number(candidate.labelBackground);
    return {
      kind: "strategy",
      sampleId: nonBlank(candidate.sampleId, ""),
      populationId: nonBlank(candidate.populationId, ""),
      fullPath: candidate.fullPath !== false,
      displayMode: validDisplayMode(candidate.displayMode),
      ...(populationIds.length ? { populationIds } : {}),
      ...(candidate.layout === "flow" ? { layout: "flow" as const } : candidate.layout === "tree" ? { layout: "tree" as const } : {}),
      ...(Number.isFinite(columns) && columns >= 1 ? { columns: Math.min(24, Math.round(columns)) } : {}),
      ...(candidate.showArrows === false ? { showArrows: false } : {}),
      ...(typeof candidate.arrowColor === "string" && candidate.arrowColor.trim() ? { arrowColor: candidate.arrowColor.trim() } : {}),
      ...(Number.isFinite(arrowWidth) && arrowWidth > 0 ? { arrowWidth: Math.min(6, arrowWidth) } : {}),
      ...(candidate.arrowAnchor === "gate" ? { arrowAnchor: "gate" as const } : {}),
      ...(Number.isFinite(plotSize) && plotSize > 0 ? { plotSize: Math.max(120, Math.min(800, Math.round(plotSize))) } : {}),
      ...(candidate.gateLabelBold === true ? { gateLabelBold: true } : {}),
      ...(candidate.labelBackground !== undefined && Number.isFinite(labelBackground) ? { labelBackground: Math.max(0, Math.min(1, labelBackground)) } : {}),
      title: typeof candidate.title === "string" ? candidate.title : undefined,
      ...(candidate.iterated === true ? { iterated: true } : {}),
      ...styleField(candidate.style),
    };
  }
  if (candidate.kind === "biplot" || candidate.kind === "histogram") {
    return {
      kind: candidate.kind,
      sampleId: nonBlank(candidate.sampleId, ""),
      populationId: nonBlank(candidate.populationId, ""),
      xChannel: nonBlank(candidate.xChannel, ""),
      yChannel: candidate.kind === "histogram"
        ? null
        : nonBlank(candidate.yChannel, "") || null,
      displayMode: validDisplayMode(candidate.displayMode),
      title: typeof candidate.title === "string" ? candidate.title : undefined,
      ...(typeof candidate.label === "string" && candidate.label.trim() ? { label: candidate.label.trim() } : {}),
      ...(candidate.iterated === true ? { iterated: true } : {}),
      ...styleField(candidate.style),
      ...poolField(candidate.pool),
    };
  }
  return null;
}

/** A plot's pool as saved: its file ids, each once and non-blank; absent when there are none. */
function poolField(value: unknown): { pool?: { sampleIds: string[] } } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const ids = (value as { sampleIds?: unknown }).sampleIds;
  if (!Array.isArray(ids)) return {};
  const sampleIds = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.trim() !== ""))];
  return sampleIds.length ? { pool: { sampleIds } } : {};
}

/** An item's zoom, 1 when it has none. */
export function layoutItemZoom(item: Pick<LayoutItemFrame, "zoom">): number {
  return typeof item.zoom === "number" && Number.isFinite(item.zoom) && item.zoom > 0 ? item.zoom : 1;
}

/** A zoom field for a record: kept within 0.1 to 4 at three decimals, absent when it is 1. */
export function zoomField(value: unknown): { zoom?: number } {
  if (typeof value !== "number" || !Number.isFinite(value)) return {};
  const zoom = Math.round(Math.min(4, Math.max(0.1, value)) * 1000) / 1000;
  return Math.abs(zoom - 1) < 0.0005 ? {} : { zoom };
}

/** A style field for a record, present only when it sets something. */
function styleField(value: unknown): { style?: Partial<LayoutPlotStyle> } {
  const style = normalizeLayoutStyle(value);
  return Object.keys(style).length ? { style } : {};
}

function normalizeItem(value: unknown, index: number): LayoutItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const recipe = normalizeRecipe(candidate.recipe);
  if (!recipe) return null;
  return {
    id: nonBlank(candidate.id, `layout-item-${index + 1}`),
    x: finiteAtLeast(candidate.x, 0, 24 + (index % 3) * 280),
    y: finiteAtLeast(candidate.y, 0, 24 + Math.floor(index / 3) * 280),
    width: finiteAtLeast(candidate.width, layoutItemMinimum(recipe.kind).width, recipe.kind === "strategy" ? 560 : 260),
    height: finiteAtLeast(candidate.height, layoutItemMinimum(recipe.kind).height, recipe.kind === "text" ? 32 : recipe.kind === "strategy" ? 300 : 280),
    showFrame: candidate.showFrame === true,
    locked: candidate.locked === true,
    ...(typeof candidate.group === "string" && candidate.group.trim() ? { group: candidate.group } : {}),
    ...zoomField(candidate.zoom),
    z: finiteAtLeast(candidate.z, 0, index),
    recipe,
  };
}

const PRESETS = new Set<string>(["custom", ...Object.keys(LAYOUT_PAGE_PRESETS)]);

/**
 * A page from a saved sheet. Version 1 sheets carried a pixel size only; that becomes a custom
 * page of the same size on screen, so an old layout opens as it was left.
 */
function normalizePage(value: unknown, widthPx: number, heightPx: number): LayoutPage {
  const fallback: LayoutPage = {
    preset: "custom",
    orientation: "portrait",
    widthMm: finiteBetween(pxToMm(widthPx), MIN_PAGE_MM, MAX_PAGE_MM, 297),
    heightMm: finiteBetween(pxToMm(heightPx), MIN_PAGE_MM, MAX_PAGE_MM, 210),
    marginMm: 0,
    dpi: 300,
    columns: 1,
    rows: 1,
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const candidate = value as Record<string, unknown>;
  const preset = (typeof candidate.preset === "string" && PRESETS.has(candidate.preset)
    ? candidate.preset
    : "custom") as LayoutPagePreset;
  const orientation: LayoutOrientation = candidate.orientation === "landscape" ? "landscape" : "portrait";
  const page = preset === "custom" ? fallback : pageForPreset(preset, orientation);
  return {
    preset,
    orientation,
    widthMm: finiteBetween(candidate.widthMm, MIN_PAGE_MM, MAX_PAGE_MM, page.widthMm),
    heightMm: finiteBetween(candidate.heightMm, MIN_PAGE_MM, MAX_PAGE_MM, page.heightMm),
    marginMm: finiteBetween(candidate.marginMm, 0, 100, page.marginMm),
    dpi: finiteBetween(candidate.dpi, 72, 1200, 300),
    columns: finiteAtLeast(candidate.columns, 1, 1) > MAX_PAGE_GRID ? MAX_PAGE_GRID : finiteAtLeast(candidate.columns, 1, 1),
    rows: finiteAtLeast(candidate.rows, 1, 1) > MAX_PAGE_GRID ? MAX_PAGE_GRID : finiteAtLeast(candidate.rows, 1, 1),
  };
}

function normalizeSheet(value: unknown, index: number): LayoutSheet | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const rawItems = Array.isArray(candidate.items) ? candidate.items : [];
  const items = rawItems.flatMap((item, itemIndex) => {
    const normalized = normalizeItem(item, itemIndex);
    return normalized ? [normalized] : [];
  });
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) item.id = crypto.randomUUID();
    seen.add(item.id);
  }
  const page = normalizePage(
    candidate.page,
    finiteAtLeast(candidate.width, 1, 1200),
    finiteAtLeast(candidate.height, 1, 800),
  );
  const size = sheetSizePx(page);
  const iteration = candidate.iteration ? normalizeIteration(candidate.iteration) : null;
  // A sheet saved with its iteration on and nothing following it drew every plot unchanged on
  // every page; its plots follow the iteration, as they do when it is switched on now.
  if (iteration && iteration.mode !== "off" && !items.some((item) => isPlotLikeRecipe(item.recipe) && item.recipe.iterated === true)) {
    for (const item of items) if (isPlotLikeRecipe(item.recipe)) item.recipe.iterated = true;
  }
  return {
    id: nonBlank(candidate.id, `layout-sheet-${index + 1}`),
    name: nonBlank(candidate.name, `Layout ${index + 1}`),
    page,
    ...(iteration ? { iteration } : {}),
    ...styleField(candidate.style),
    ...(typeof candidate.titleTemplate === "string" && candidate.titleTemplate.trim() ? { titleTemplate: candidate.titleTemplate } : {}),
    width: size.width,
    height: size.height,
    items,
  };
}

export function createLayoutSheet(name = "Layout 1", page: LayoutPage = defaultLayoutPage()): LayoutSheet {
  const size = sheetSizePx(page);
  return {
    id: crypto.randomUUID(),
    name,
    page,
    width: size.width,
    height: size.height,
    items: [],
  };
}

export function createDefaultLayoutWorkspace(): LayoutWorkspace {
  const sheet = createLayoutSheet();
  return {
    version: LAYOUT_WORKSPACE_VERSION,
    activeSheetId: sheet.id,
    sheets: [sheet],
  };
}

/**
 * Parse persisted layout state defensively. Layouts are presentation-only: a malformed layout
 * is replaced with a clean sheet rather than preventing scientifically valid gating data from
 * opening.
 */
export function normalizeLayoutWorkspace(value: unknown): LayoutWorkspace {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createDefaultLayoutWorkspace();
  }
  const candidate = value as Record<string, unknown>;
  const rawSheets = Array.isArray(candidate.sheets) ? candidate.sheets : [];
  const sheets = rawSheets.flatMap((sheet, index) => {
    const normalized = normalizeSheet(sheet, index);
    return normalized ? [normalized] : [];
  });
  if (sheets.length === 0) return createDefaultLayoutWorkspace();

  const seen = new Set<string>();
  for (const sheet of sheets) {
    if (seen.has(sheet.id)) sheet.id = crypto.randomUUID();
    seen.add(sheet.id);
  }
  const requestedActive = nonBlank(candidate.activeSheetId, "");
  return {
    version: LAYOUT_WORKSPACE_VERSION,
    activeSheetId: sheets.some(({ id }) => id === requestedActive)
      ? requestedActive
      : sheets[0].id,
    sheets,
  };
}

const PLACEMENT_STEP = 20;

/**
 * Where a new item goes: the first spot inside the first page's margin, scanned row by row on a
 * 20 px lattice, where it overlaps nothing; when the page is full, a cascade from the last item
 * so the new one is still on the page and in view.
 */
export function nextLayoutItemPosition(
  sheet: LayoutSheet,
  width = 260,
  height = 280,
): Pick<LayoutItemFrame, "x" | "y" | "width" | "height" | "z"> {
  const z = Math.max(0, ...sheet.items.map(({ z }) => z)) + 1;
  const page = pageSizePx(sheet.page);
  const inset = Math.max(24, mmToPx(sheet.page.marginMm));
  const gap = 12;
  const overlaps = (x: number, y: number) =>
    sheet.items.some((item) =>
      x < item.x + item.width + gap && x + width + gap > item.x &&
      y < item.y + item.height + gap && y + height + gap > item.y);
  for (let y = inset; y + height <= page.height - inset; y += PLACEMENT_STEP) {
    for (let x = inset; x + width <= page.width - inset; x += PLACEMENT_STEP) {
      if (!overlaps(x, y)) return { x, y, width, height, z };
    }
  }
  // Nothing on the page holds it: it goes below everything, and the sheet grows to show it,
  // rather than over whatever was placed last.
  const bottom = Math.max(inset - gap, ...sheet.items.map((item) => item.y + item.height));
  return { x: inset, y: bottom + gap, width, height, z };
}

/** Where a plot sits in a grid of plots added together: row and column from the top left. */
export interface LayoutGridCell {
  row: number;
  column: number;
}

/**
 * Frames for plots added together as a grid, one per cell, in the arrangement they had where
 * they came from. The grid goes below whatever the sheet holds, at the page margin, and the
 * caller grows the sheet to hold it: a row stays a row however wide the page is. Plots sharing a
 * cell are stepped so that each can be seen.
 */
/** A heading for a row or column of plots put on a sheet: its text, and a template a text block bound to the first plot reads instead, when the heading is what that plot's file or population says. */
export interface LayoutGridHeading {
  text: string;
  template?: string;
}
export interface LayoutGridHeadings {
  columns: LayoutGridHeading[];
  rows: LayoutGridHeading[];
}

export function layoutGridFrames(
  sheet: LayoutSheet,
  cells: readonly LayoutGridCell[],
  width = 260,
  height = 280,
): Pick<LayoutItemFrame, "x" | "y" | "width" | "height" | "z">[] {
  const inset = Math.max(24, mmToPx(sheet.page.marginMm));
  const gap = 12;
  const top = sheet.items.length ? Math.max(...sheet.items.map((item) => item.y + item.height)) + gap : inset;
  let z = Math.max(0, ...sheet.items.map((item) => item.z));
  const seen = new Map<string, number>();
  return cells.map((cell) => {
    const key = `${cell.row},${cell.column}`;
    const k = seen.get(key) ?? 0;
    seen.set(key, k + 1);
    return {
      x: inset + cell.column * (width + gap) + k * PLACEMENT_STEP,
      y: top + cell.row * (height + gap) + k * PLACEMENT_STEP,
      width,
      height,
      z: ++z,
    };
  });
}

export function cloneLayoutWorkspace(workspace: LayoutWorkspace): LayoutWorkspace {
  return {
    version: LAYOUT_WORKSPACE_VERSION,
    activeSheetId: workspace.activeSheetId,
    sheets: workspace.sheets.map((sheet) => ({
      ...sheet,
      page: { ...sheet.page },
      ...(sheet.iteration ? { iteration: { ...sheet.iteration, source: { ...sheet.iteration.source }, arrangement: { ...sheet.iteration.arrangement } } } : {}),
      items: sheet.items.map((item) => ({
        ...item,
        recipe: {
          ...item.recipe,
          ...("pool" in item.recipe && item.recipe.pool ? { pool: { sampleIds: [...item.recipe.pool.sampleIds] } } : {}),
          ...(item.recipe.kind === "strategy" && item.recipe.populationIds ? { populationIds: [...item.recipe.populationIds] } : {}),
        },
      })),
    })),
  };
}

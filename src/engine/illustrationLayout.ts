import type { PopulationMap } from "./models";
import {
  buildIllustrationPayload,
  type IllustrationOptions,
  type IllustrationPopulationSelection,
  type IllustrationSampleSource,
} from "./illustration";

export const ILLUSTRATION_DIMENSIONS = ["files", "populations", "channels"] as const;
export type IllustrationDimension = typeof ILLUSTRATION_DIMENSIONS[number];
export type IllustrationDimensionAxis = "rows" | "columns" | "overlay";

export interface IllustrationDimensionLayout {
  rows: IllustrationDimension[];
  columns: IllustrationDimension[];
  overlay: IllustrationDimension[];
}

export const DEFAULT_ILLUSTRATION_LAYOUT: IllustrationDimensionLayout = {
  rows: ["files", "populations"],
  columns: ["channels"],
  overlay: [],
};

export function legacyIllustrationLayout(
  combineSamples: boolean,
  overlayPopulations: boolean,
): IllustrationDimensionLayout {
  return {
    rows: [
      ...(combineSamples ? [] : ["files"] as IllustrationDimension[]),
      ...(overlayPopulations ? [] : ["populations"] as IllustrationDimension[]),
    ],
    columns: ["channels"],
    overlay: [
      ...(combineSamples ? ["files"] as IllustrationDimension[] : []),
      ...(overlayPopulations ? ["populations"] as IllustrationDimension[] : []),
    ],
  };
}

/** Repair old, partial or hand-edited workspace settings into one placement per dimension. */
export function normalizeIllustrationLayout(
  input: Partial<IllustrationDimensionLayout> | null | undefined,
  fallback: IllustrationDimensionLayout = DEFAULT_ILLUSTRATION_LAYOUT,
): IllustrationDimensionLayout {
  const valid = new Set<IllustrationDimension>(ILLUSTRATION_DIMENSIONS);
  const seen = new Set<IllustrationDimension>();
  const take = (
    values: readonly IllustrationDimension[] | undefined,
    axis: IllustrationDimensionAxis,
  ): IllustrationDimension[] => (values ?? []).flatMap((dimension) => {
    if (!valid.has(dimension) || seen.has(dimension)) return [];
    // Different channels cannot share one quantitative axis, so Channels is never an overlay.
    if (axis === "overlay" && dimension === "channels") return [];
    seen.add(dimension);
    return [dimension];
  });
  const rows = take(input?.rows, "rows");
  const columns = take(input?.columns, "columns");
  const overlay = take(input?.overlay, "overlay");
  for (const axis of ["rows", "columns", "overlay"] as const) {
    for (const dimension of fallback[axis]) {
      if (seen.has(dimension) || (axis === "overlay" && dimension === "channels")) continue;
      seen.add(dimension);
      (axis === "rows" ? rows : axis === "columns" ? columns : overlay).push(dimension);
    }
  }
  for (const dimension of ILLUSTRATION_DIMENSIONS) {
    if (seen.has(dimension)) continue;
    (dimension === "channels" ? columns : rows).push(dimension);
    seen.add(dimension);
  }
  return { rows, columns, overlay };
}

export function moveIllustrationDimension(
  layout: IllustrationDimensionLayout,
  dimension: IllustrationDimension,
  target: IllustrationDimensionAxis,
  targetIndex?: number,
): IllustrationDimensionLayout {
  const normalized = normalizeIllustrationLayout(layout);
  if (dimension === "channels" && target === "overlay") return normalized;
  const next: IllustrationDimensionLayout = {
    rows: normalized.rows.filter((item) => item !== dimension),
    columns: normalized.columns.filter((item) => item !== dimension),
    overlay: normalized.overlay.filter((item) => item !== dimension),
  };
  const list = next[target];
  const index = Math.max(0, Math.min(list.length, targetIndex ?? list.length));
  list.splice(index, 0, dimension);
  return next;
}

export interface IllustrationDimensionValue {
  dimension: IllustrationDimension;
  id: string;
  label: string;
}

export interface IllustrationLayoutPanel {
  key: string;
  row: IllustrationDimensionValue[];
  column: IllustrationDimensionValue[];
  config: Record<string, unknown> | null;
  description: string;
}

export interface IllustrationLayoutPayload {
  layout: IllustrationDimensionLayout;
  rowGroups: IllustrationDimensionValue[][];
  columnGroups: IllustrationDimensionValue[][];
  panels: IllustrationLayoutPanel[];
  overlayLabel: string;
  plotSize: number;
  fitToColumns: boolean;
  fontSizes: IllustrationOptions["fontSizes"];
  scaleFontsWithPlot: boolean;
}

interface BuiltGridPayload {
  plots: Record<string, Record<string, unknown> & { x?: number[]; y?: number[] }>;
  gate_overlays: Record<string, unknown>;
  pop_names: Record<string, string>;
  pop_counts: Record<string, number>;
}

type Combination = Partial<Record<IllustrationDimension, IllustrationDimensionValue>>;

function combinations(
  dimensions: readonly IllustrationDimension[],
  values: Readonly<Record<IllustrationDimension, readonly IllustrationDimensionValue[]>>,
): IllustrationDimensionValue[][] {
  return dimensions.reduce<IllustrationDimensionValue[][]>(
    (previous, dimension) => previous.flatMap((prefix) =>
      values[dimension].map((value) => [...prefix, value])),
    [[]],
  );
}

function asCombination(values: readonly IllustrationDimensionValue[]): Combination {
  return Object.fromEntries(values.map((value) => [value.dimension, value])) as Combination;
}

function selectedPopulationIds(
  source: IllustrationSampleSource,
  orderedPopulationIds: readonly string[],
  selection: IllustrationPopulationSelection | undefined,
): string[] {
  if (!selection) return [...orderedPopulationIds];
  const selected = new Set(selection[source.id] ?? []);
  return orderedPopulationIds.filter((populationId) => selected.has(populationId));
}

function channelLabel(
  sources: readonly IllustrationSampleSource[],
  channel: string,
): string {
  return sources.find((source) => source.sample.index(channel) !== undefined)
    ?.sample.labelForKey(channel) ?? channel;
}

/**
 * Build the declarative Illustration grid used by the React editor.
 *
 * Rows and columns are Cartesian dimensions. Moving Files or Populations to Overlay collapses
 * that dimension into each cell: files are concatenated; populations become named colour traces.
 * Channels cannot be overlaid because they do not share a quantitative axis.
 */
export function buildIllustrationLayoutPayload(
  sources: readonly IllustrationSampleSource[],
  referenceSampleId: string | null,
  gates: Parameters<typeof buildIllustrationPayload>[1],
  gateOrder: string[],
  populations: PopulationMap,
  populationIds: string[],
  xChannels: string[],
  yChannel: string | null,
  globalScales: Record<string, [number, number]>,
  options: IllustrationOptions,
  requestedLayout: IllustrationDimensionLayout,
  selectedBySample?: IllustrationPopulationSelection,
): IllustrationLayoutPayload {
  const layout = normalizeIllustrationLayout(requestedLayout);
  const selectedPairCount = sources.reduce(
    (total, source) => total + selectedPopulationIds(
      source,
      populationIds,
      selectedBySample,
    ).length,
    0,
  );
  const panelCount = Math.max(1, selectedPairCount) * Math.max(1, xChannels.length);
  const sharedPreviewCap = Math.max(500, Math.floor(300_000 / panelCount));
  const requestedCap = Number.isFinite(options.maxEvents) && options.maxEvents > 0
    ? options.maxEvents
    : Infinity;
  const sourceOptions = {
    ...options,
    maxEvents: Math.min(requestedCap, sharedPreviewCap),
  };
  const built = new Map(sources.map((source) => [
    source.id,
    buildIllustrationPayload(
      source.sample,
      gates,
      gateOrder,
      populations,
      source.masks,
      source.eventCount,
      selectedPopulationIds(source, populationIds, selectedBySample),
      xChannels,
      yChannel,
      globalScales,
      sourceOptions,
    ) as unknown as BuiltGridPayload,
  ]));

  const dimensionValues: Record<IllustrationDimension, IllustrationDimensionValue[]> = {
    files: sources.map((source) => ({ dimension: "files", id: source.id, label: source.name })),
    populations: populationIds.map((populationId) => ({
      dimension: "populations",
      id: populationId,
      label: populations[populationId]?.name ?? populationId,
    })),
    channels: xChannels.map((channel) => ({
      dimension: "channels",
      id: channel,
      label: channelLabel(sources, channel),
    })),
  };
  const rowGroups = combinations(layout.rows, dimensionValues);
  const columnGroups = combinations(layout.columns, dimensionValues);
  const overlayFiles = layout.overlay.includes("files");
  const overlayPopulations = layout.overlay.includes("populations");
  const populationColours = options.populationColors;

  const panels = rowGroups.flatMap((row, rowIndex) => columnGroups.map((column, columnIndex) => {
    const fixed = { ...asCombination(row), ...asCombination(column) };
    const sourceIds = overlayFiles
      ? sources.map((source) => source.id)
      : fixed.files ? [fixed.files.id] : [];
    const panelPopulationIds = overlayPopulations
      ? populationIds
      : fixed.populations ? [fixed.populations.id] : [];
    const channel = fixed.channels?.id ?? xChannels[0] ?? "";
    const traces = panelPopulationIds.flatMap((populationId) => {
      const available = sourceIds.flatMap((sourceId) => {
        if (selectedBySample && !(selectedBySample[sourceId] ?? []).includes(populationId)) return [];
        const plot = built.get(sourceId)?.plots[`${populationId}|${channel}`];
        return plot ? [{ sourceId, plot }] : [];
      });
      if (available.length === 0) return [];
      const template = available[0].plot;
      return [{
        populationId,
        template,
        sourceIds: available.map(({ sourceId }) => sourceId),
        x: available.flatMap(({ plot }) => plot.x ?? []),
        y: available.flatMap(({ plot }) => plot.y ?? []),
      }];
    });

    const first = traces[0];
    let config: Record<string, unknown> | null = null;
    if (first && channel) {
      const referenceSourceId = first.sourceIds.includes(referenceSampleId ?? "")
        ? referenceSampleId!
        : first.sourceIds[0];
      const referenceGates = overlayPopulations
        ? []
        : built.get(referenceSourceId)?.gate_overlays[`${first.populationId}|${channel}`] ?? [];
      config = {
        ...first.template,
        x: first.x,
        y: first.y,
        display_mode: options.displayMode,
        contour_threshold: options.contourThreshold,
        point_alpha: options.pointAlpha,
        density_color_power: options.densityColorPower,
        point_size: options.pointSize,
        hist_line_width: options.histLineWidth,
        hist_fill: options.histFill,
        hist_fill_alpha: options.histFillAlpha,
        hist_overlay_mode: options.histOverlayMode,
        kde_bandwidth: options.kdeBandwidth,
        title: null,
        font_sizes: options.fontSizes,
        gate_style: {
          pub_style: options.pubStyle,
          line_width: options.gateLineWidth,
          gate_edge_mode: options.gateEdgeMode ?? "straight-bow",
        },
        pop_color: populationColours[first.populationId] ?? "#444444",
        overlay_traces: traces.slice(1).map((trace) => ({
          x: trace.x,
          y: trace.y,
          color: populationColours[trace.populationId] ?? "#444444",
          name: populations[trace.populationId]?.name ?? trace.populationId,
        })),
        legend_entries: overlayPopulations ? traces.map((trace) => ({
          color: populationColours[trace.populationId] ?? "#444444",
          name: populations[trace.populationId]?.name ?? trace.populationId,
        })) : [],
        gates: referenceGates,
      };
    }

    const descriptionParts = [
      ...row.map(({ label }) => label),
      ...column.map(({ label }) => label),
      ...(overlayFiles ? [`${sourceIds.length} files pooled`] : []),
      ...(overlayPopulations ? [`${traces.length} populations overlaid`] : []),
    ];
    return {
      key: `${rowIndex}:${columnIndex}:${sourceIds.join(",")}:${panelPopulationIds.join(",")}:${channel}`,
      row,
      column,
      config,
      description: descriptionParts.join(" · "),
    };
  }));

  const overlayLabel = layout.overlay.flatMap((dimension) => {
    if (dimension === "files") return sources.length > 1 ? [`Files pooled (${sources.length})`] : ["File"];
    if (dimension === "populations") return populationIds.length > 1
      ? [`Populations overlaid (${populationIds.length})`]
      : ["Population"];
    return [];
  }).join(" · ");

  return {
    layout,
    rowGroups,
    columnGroups,
    panels,
    overlayLabel,
    plotSize: options.plotSize,
    fitToColumns: options.fitToColumns,
    fontSizes: options.fontSizes,
    scaleFontsWithPlot: options.scaleFontsWithPlot,
  };
}

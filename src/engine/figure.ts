import type { CoreState, GatingDerived } from "../store";
import { recomputeGating } from "../store";
import { storeHierarchy, type StoredHierarchy } from "./hierarchies";
import type { TransformSpec } from "./models";
import { transformFromSpec, type Sample } from "./sample";
import { linearScatterTicks, logicleTicks, scatterTicks } from "./ticks";
import { populationTreeOrder } from "./populations";
import {
  buildIllustrationPayload,
  type IllustrationOptions,
} from "./illustration";
import { computeRangeFromValues } from "./strategy";
import type { IllustrationConfig } from "./workspace";
import { exactMedian } from "./heatmap";
import { isFigureSpec } from "./figureSchema";
import { templateOf } from "./groups";
import {
  legacyIllustrationLayout,
  normalizeIllustrationLayout,
} from "./illustrationLayout";

export interface FigurePopulation {
  hierarchyId: string;
  populationId: string;
  label: string;
}
export interface FigurePlot {
  id: string;
  name: string;
  x: string;
  y: string;
  type: "biplot" | "histogram" | "heatmap";
  population?: FigurePopulation;
}
export type FigureDimension =
  | "samples"
  | "populations"
  | "plots"
  | `metadata:${string}`;
export interface FigureSpec {
  version: 1;
  name: string;
  sampleIds: string[];
  populations: FigurePopulation[];
  plots: FigurePlot[];
  rows: FigureDimension[];
  columns: FigureDimension[];
  pages: FigureDimension[];
  composition: "separate" | "overlay" | "pool";
  /** Shared by channel across the figure's files, fitted per file, or the Gating tab's own ranges. */
  scalePolicy: "shared" | "individual" | "gating";
  /**
   * The user set the axis policy. Without it, a saved "shared" is the default of the versions
   * before the Gating tab's axes could be followed, and loads as "gating".
   */
  scalePolicyChosen?: boolean;
  transforms: Record<string, TransformSpec>;
  showGates: boolean;
  panelSize: number;
  overlayPopulations?: boolean;
  /** The figure's data selection is independent of the gating sidebar. */
  samplePopulations?: Record<string, FigurePopulation[]>;
  /** Explicitly reviewed sample-local correspondence, keyed by the selected source reference. */
  populationOverrides?: Record<string, Record<string, string>>;
  /**
   * Where the figure draws each gate's label, as an offset from the gate in display units,
   * keyed by the gate's id in the tree the figure was made on (a copy's gate maps to it). The
   * Gating tab keeps its own placement: panels are smaller, so labels are placed again here.
   */
  labelOffsets?: Record<string, [number, number]>;
}
export interface FigureSample {
  id: string;
  name: string;
  fileName?: string;
  sample: Sample;
  hierarchyId: string;
  metadata?: Record<string, string>;
}
export interface FigureSource extends FigureSample {
  tree: StoredHierarchy;
  gating: GatingDerived;
}
export interface FigureValue {
  dimension: FigureDimension;
  id: string;
  label: string;
}
export interface FigurePanel {
  key: string;
  samples: string[];
  population: FigurePopulation;
  populations?: FigurePopulation[];
  plot: FigurePlot;
  row: number;
  column: number;
}
export interface FigurePage {
  key: string;
  label: string;
  rows: FigureValue[][];
  columns: FigureValue[][];
  panels: FigurePanel[];
}
export type PopulationResolution =
  | { status: "matched" | "tailored" | "changed"; id: string }
  | { status: "missing" | "ambiguous"; id?: never };

/** Snapshot the active tree as well as parked trees; never switch the user's active hierarchy. */
export function figureHierarchies(
  state: CoreState,
): Record<string, StoredHierarchy> {
  const active = state.hierarchies.find(
    (h) => h.id === state.active_hierarchy_id,
  )!;
  return {
    ...state.stored_hierarchies,
    [active.id]: storeHierarchy(active, state),
  };
}

/** Immediate provenance edges, not labels, establish correspondence. Cycle guards also protect legacy imports. */
export function populationLineage(
  ref: FigurePopulation,
  trees: Record<string, StoredHierarchy>,
): string[] {
  const path: string[] = [];
  let hid = ref.hierarchyId,
    pid = ref.populationId;
  while (hid && pid) {
    const key = JSON.stringify([hid, pid]);
    if (path.includes(key)) break;
    path.push(key);
    const tree = trees[hid];
    const parent = tree?.source_population_ids?.[pid];
    if (!parent || !tree.source_hierarchy_id) break;
    pid = parent;
    hid = tree.source_hierarchy_id;
  }
  return path;
}

export function canonicalPopulation(
  ref: FigurePopulation,
  trees: Record<string, StoredHierarchy>,
): FigurePopulation {
  const [hierarchyId, populationId] = JSON.parse(
    populationLineage(ref, trees).at(-1)!,
  ) as [string, string];
  return {
    hierarchyId,
    populationId,
    label: trees[hierarchyId]?.populations[populationId]?.name ?? ref.label,
  };
}

export function resolveFigurePopulation(
  ref: FigurePopulation,
  tree: StoredHierarchy,
  trees: Record<string, StoredHierarchy>,
): PopulationResolution {
  if (ref.hierarchyId === tree.id && tree.populations[ref.populationId])
    return { status: "matched", id: ref.populationId };
  const lineage = new Set(populationLineage(ref, trees));
  const candidates = Object.keys(tree.populations).filter((id) =>
    populationLineage(
      { hierarchyId: tree.id, populationId: id, label: "" },
      trees,
    ).some((key) => lineage.has(key)),
  );
  if (!candidates.length) return { status: "missing" };
  if (candidates.length > 1) return { status: "ambiguous" };
  const id = candidates[0];
  const geometry = (gate: unknown) =>
    JSON.stringify(gate, (key, value) =>
      ["gate_id", "name", "color", "label_offset"].includes(key)
        ? undefined
        : value,
    );
  const seen = new Set<string>();
  function drift(
    current: StoredHierarchy,
    pid: string,
  ): "matched" | "tailored" | "changed" {
    const key = JSON.stringify([current.id, pid]);
    if (seen.has(key)) return "matched";
    seen.add(key);
    const parent = trees[current.source_hierarchy_id ?? ""],
      pop = current.populations[pid];
    if (!pop) return "changed";
    if (!parent) return "matched";
    const sourceId = current.source_population_ids?.[pid] ?? "",
      sourcePop = parent.populations[sourceId];
    if (!sourcePop) return "changed";
    const references = pop.gate_refs.map((r) => ({
      ...r,
      gate_id: current.source_gate_ids?.[r.gate_id] ?? r.gate_id,
    }));
    if (
      JSON.stringify(references) !== JSON.stringify(sourcePop.gate_refs) ||
      pop.gate_logic !== sourcePop.gate_logic ||
      (pop.parent_id
        ? current.source_population_ids?.[pop.parent_id]
        : null) !== sourcePop.parent_id
    )
      return "changed";
    let tailored = false;
    for (const ref of pop.gate_refs) {
      const own = current.gates[ref.gate_id],
        original = parent.gates[current.source_gate_ids?.[ref.gate_id] ?? ""];
      if (
        !own ||
        !original ||
        own.gate_type !== original.gate_type ||
        own.x_channel !== original.x_channel ||
        own.y_channel !== original.y_channel
      )
        return "changed";
      tailored ||= geometry(own) !== geometry(original);
    }
    // Parent gates determine this population's membership too, including across copy generations.
    const inherited = [
      pop.parent_id ? drift(current, pop.parent_id) : "matched",
      drift(parent, sourceId),
    ];
    if (inherited.includes("changed")) return "changed";
    return tailored || inherited.includes("tailored") ? "tailored" : "matched";
  }
  return { status: drift(tree, id), id };
}

export function figurePopulationOptions(
  trees: Record<string, StoredHierarchy>,
): FigurePopulation[] {
  const seen = new Set<string>();
  return Object.values(trees).flatMap((tree) =>
    populationTreeOrder(
      tree.populations,
      tree.root_population_id ?? "",
    ).flatMap(({ popId }) => {
      const ref = canonicalPopulation(
        {
          hierarchyId: tree.id,
          populationId: popId,
          label: tree.populations[popId].name,
        },
        trees,
      );
      const key = JSON.stringify([ref.hierarchyId, ref.populationId]);
      if (seen.has(key)) return [];
      seen.add(key);
      return [ref];
    }),
  );
}

export function migrateFigure(
  config: IllustrationConfig | null,
  samples: readonly FigureSample[],
  trees: Record<string, StoredHierarchy>,
  activeHierarchyId: string,
  x: string,
  y: string,
): FigureSpec {
  if (config?.figure) {
    if (!isFigureSpec(config.figure))
      throw new Error("The saved figure settings are malformed.");
    const saved = structuredClone(config.figure);
    if (saved.scalePolicy === "shared" && !saved.scalePolicyChosen) saved.scalePolicy = "gating";
    return saved;
  }
  const tree = trees[activeHierarchyId];
  const refFor = (id: string): FigurePopulation => {
    const owner = Object.values(trees).find((h) => h.populations[id]);
    // Unresolvable legacy selections remain explicit errors, never silently become All Events.
    return owner
      ? canonicalPopulation(
          {
            hierarchyId: owner.id,
            populationId: id,
            label: owner.populations[id].name,
          },
          trees,
        )
      : {
          hierarchyId: activeHierarchyId,
          populationId: id,
          label: "Unavailable saved population",
        };
  };
  const populationIds = config
    ? config.popIds
    : [tree.active_population_id ?? tree.root_population_id ?? ""];
  const figure: FigureSpec = {
    version: 1,
    name: "File / sample comparison",
    sampleIds: samples.map((s) => s.id),
    populations: populationIds.filter(Boolean).map(refFor),
    plots: (config?.xChannels ?? [x]).map((ch, i) => ({
      id: `plot-${i}`,
      name: samples[0]?.sample.labelForKey(ch) ?? ch,
      x: ch,
      y: config?.yChannel || y,
      type:
        config?.plotType === "heatmap"
          ? "heatmap"
          : config?.plotType === "histogram" || config?.yChannel === ""
            ? "histogram"
            : "biplot",
    })),
    rows: ["populations", "plots"],
    columns: ["samples"],
    pages: [],
    composition: config?.combineSamples ? "pool" : "separate",
    // A new figure shows each channel on the range the Gating tab shows it, where the Gating
    // tab has one; a channel it has not fitted spans the files' data as "shared" does.
    scalePolicy: "gating",
    transforms: {},
    showGates: true,
    panelSize: Math.max(240, config?.plotSize ?? 280),
    ...(config?.selectionMode === "matrix"
      ? {
          samplePopulations: Object.fromEntries(
            Object.entries(config.selectedPopulationsBySample ?? {}).map(
              ([id, ids]) => [id, ids.map(refFor)],
            ),
          ),
        }
      : {}),
  };
  if (config) {
    const old = normalizeIllustrationLayout(
      config.dimensionLayout,
      legacyIllustrationLayout(
        !!config.combineSamples,
        config.overlayPops || config.histLayout === "ridgeline",
      ),
    );
    const convert = (dims: typeof old.rows): FigureDimension[] =>
      dims.map((d) =>
        d === "files" ? "samples" : d === "channels" ? "plots" : d,
      );
    figure.rows = [...convert(old.rows), ...convert(old.overlay)];
    figure.columns = convert(old.columns);
    figure.composition = old.overlay.includes("files") ? "pool" : "separate";
    figure.overlayPopulations = old.overlay.includes("populations");
  }
  return captureFigureTransforms(figure, samples);
}

export function captureFigureTransforms(
  figure: FigureSpec,
  samples: readonly FigureSample[],
): FigureSpec {
  const transforms = { ...figure.transforms };
  for (const key of new Set(
    figure.plots.flatMap((p) => [p.x, ...(p.type === "biplot" ? [p.y] : [])]),
  )) {
    const sample = samples.find(
      (s) => s.sample.index(key) !== undefined,
    )?.sample;
    if (sample && !transforms[key]) transforms[key] = sample.transformSpec(key);
  }
  return { ...figure, transforms };
}

export function prepareFigureSource(
  source: FigureSample,
  tree: StoredHierarchy,
  state: CoreState,
): FigureSource {
  return {
    ...source,
    tree,
    gating: recomputeGating(source.sample, {
      ...state,
      ...tree,
      active_hierarchy_id: tree.id,
    }),
  };
}

/** A read-only projection: fixed figure transforms never mutate a Sample or the global Scales tab. */
export function figureDisplaySample(
  sample: Sample,
  specs: Record<string, TransformSpec>,
): Sample {
  const projected = Object.create(sample) as Sample;
  const columns = new Map<number, Float32Array>();
  const transforms = new Map(
    Object.entries(specs).map(([key, spec]) => [key, transformFromSpec(spec)]),
  );
  projected.displayColumn = (idx) => {
    if (columns.has(idx)) return columns.get(idx)!;
    const t = transforms.get(sample.channels[idx].key);
    const column = t
      ? Float32Array.from(sample.rawColumnData(idx), (value) =>
          t.forward(value),
        )
      : sample.displayColumn(idx);
    columns.set(idx, column);
    return column;
  };
  projected.rawToDisplay = (key, value) =>
    transforms.get(key)?.forward(value) ?? sample.rawToDisplay(key, value);
  projected.displayToRaw = (key, value) =>
    transforms.get(key)?.inverse(value) ?? sample.displayToRaw(key, value);
  projected.gateToDisplay = (gate, key, value) =>
    projected.rawToDisplay(key, sample.gateToRaw(gate, key, value));
  projected.displayToGate = (gate, key, value) =>
    sample.rawToGate(gate, key, projected.displayToRaw(key, value));
  projected.channelTicks = (idx, range) => {
    const key = sample.channels[idx].key,
      spec = specs[key],
      t = transforms.get(key);
    if (!spec || !t) return sample.channelTicks(idx, range);
    if (spec.kind === "identity") return linearScatterTicks(range);
    if (spec.kind === "logicle")
      return logicleTicks(
        (v) => t.forward(v),
        (v) => t.inverse(v),
        range,
        spec.T,
      );
    return scatterTicks(
      (v) => t.forward(v),
      (v) => t.inverse(v),
      range,
      spec.kind === "asinh" ? spec.cofactor : 1,
    );
  };
  // Gating always uses the original assay and the gate's recorded coordinate space.
  projected.gateAssayData = () => sample.gateAssayData();
  return projected;
}

function combinations(
  dimensions: FigureDimension[],
  values: Map<FigureDimension, FigureValue[]>,
): FigureValue[][] {
  return dimensions.reduce<FigureValue[][]>(
    (rows, dimension) =>
      rows.flatMap((row) =>
        (values.get(dimension) ?? []).map((value) => [...row, value]),
      ),
    [[]],
  );
}

export function layoutFigure(
  figure: FigureSpec,
  samples: readonly FigureSample[],
  trees?: Record<string, StoredHierarchy>,
): FigurePage[] {
  if (
    !figure.sampleIds.length ||
    !figure.populations.length ||
    !figure.plots.length
  )
    return [];
  const selected: {
    id: string;
    name: string;
    metadata?: Record<string, string>;
  }[] = figure.sampleIds.map(
    (id) =>
      samples.find((s) => s.id === id) ?? {
        id,
        name: "Missing file",
        metadata: {},
      },
  );
  const values = new Map<FigureDimension, FigureValue[]>([
    [
      "samples",
      selected.map((s) => ({ dimension: "samples", id: s.id, label: s.name })),
    ],
    [
      "populations",
      figure.populations.map((p, i) => ({
        dimension: "populations",
        id: String(i),
        label: p.label,
      })),
    ],
    [
      "plots",
      figure.plots.map((p) => ({
        dimension: "plots",
        id: p.id,
        label: p.name,
      })),
    ],
  ]);
  for (const dimension of [...figure.rows, ...figure.columns, ...figure.pages])
    if (dimension.startsWith("metadata:")) {
      const name = dimension.slice(9);
      values.set(
        dimension,
        [
          ...new Set(selected.map((s) => s.metadata?.[name] ?? "Unassigned")),
        ].map((value) => ({ dimension, id: value, label: value })),
      );
    }
  const visible = (dims: FigureDimension[]) =>
    dims.filter(
      (d) =>
        (d !== "samples" || figure.composition === "separate") &&
        (d !== "populations" || !figure.overlayPopulations),
    );
  const combinationsCount = [
    ...figure.pages,
    ...visible(figure.rows),
    ...visible(figure.columns),
  ].reduce((n, d) => n * (values.get(d)?.length ?? 0), 1);
  if (combinationsCount > 50000)
    throw new Error(
      "This arrangement exceeds 50,000 combinations. Select fewer files / samples, populations or metadata groupings.",
    );
  return combinations(figure.pages, values)
    .map((page) => {
      const rows = combinations(visible(figure.rows), values),
        columns = combinations(visible(figure.columns), values);
      const panels = rows.flatMap((row, ri) =>
        columns.map((column, ci) => {
          const dimensions = [...page, ...row, ...column];
          const value = (name: string) =>
            dimensions.find((d) => d.dimension === name)?.id;
          const plot =
            figure.plots.find((p) => p.id === value("plots")) ??
            figure.plots[0];
          const population =
            plot.population ??
            figure.populations[Number(value("populations") ?? 0)];
          const populations =
            figure.overlayPopulations &&
            !plot.population &&
            !figure.pages.includes("populations")
              ? figure.populations
              : undefined;
          const sampleIds = selected
            .filter(
              (s) =>
                (!value("samples") || s.id === value("samples")) &&
                (!trees ||
                  (populations ?? [population]).some((ref) =>
                    figurePopulationApplies(
                      ref,
                      samples.find((file) => file.id === s.id),
                      trees,
                      figure,
                    ),
                  )) &&
                dimensions.every(
                  (d) =>
                    !d.dimension.startsWith("metadata:") ||
                    (s.metadata?.[d.dimension.slice(9)] ?? "Unassigned") ===
                      d.id,
                ),
            )
            .map((s) => s.id);
          return {
            key: JSON.stringify(dimensions),
            samples: sampleIds,
            population,
            populations,
            plot,
            row: ri,
            column: ci,
          };
        }),
      );
      // Metadata is a property of a sample, not a second independent sample dimension.
      const usedRows = rows
        .map((_, i) => i)
        .filter((i) => panels.some((p) => p.row === i && p.samples.length));
      const usedColumns = columns
        .map((_, i) => i)
        .filter((i) => panels.some((p) => p.column === i && p.samples.length));
      return {
        key: JSON.stringify(page),
        label: page.map((v) => v.label).join(" / ") || figure.name,
        rows: usedRows.map((i) => rows[i]),
        columns: usedColumns.map((i) => columns[i]),
        panels: panels
          .filter(
            (p) => usedRows.includes(p.row) && usedColumns.includes(p.column),
          )
          .map((p) => ({
            ...p,
            row: usedRows.indexOf(p.row),
            column: usedColumns.indexOf(p.column),
          })),
      };
    })
    .filter((page) => page.panels.length);
}

/** A population belongs to its hierarchy family, not every similarly named tree in a workspace. */
export function figurePopulationApplies(
  ref: FigurePopulation,
  file: FigureSample | undefined,
  trees: Record<string, StoredHierarchy>,
  figure: Pick<FigureSpec, "populationOverrides">,
): boolean {
  // Missing saved data or references remain actionable errors, never silently disappear.
  if (
    !file ||
    !trees[file.hierarchyId] ||
    !trees[ref.hierarchyId]?.populations[ref.populationId]
  )
    return true;
  if (
    figure.populationOverrides?.[file.id]?.[
      JSON.stringify([ref.hierarchyId, ref.populationId])
    ]
  )
    return true;
  const refs = Object.values(trees);
  if (
    templateOf(file.hierarchyId, refs)?.id ===
    templateOf(ref.hierarchyId, refs)?.id
  )
    return true;
  const lineage = new Set(populationLineage(ref, trees));
  return Object.keys(trees[file.hierarchyId].populations).some((populationId) =>
    populationLineage(
      { hierarchyId: file.hierarchyId, populationId, label: "" },
      trees,
    ).some((id) => lineage.has(id)),
  );
}

export interface FigurePanelData {
  config: Record<string, unknown> | null;
  problem?: string;
  omitted?: boolean;
  mappings: { sample: string; status: PopulationResolution["status"] }[];
}

/**
 * A gate's id in the tree its copies descend from: a copy's gate maps to its source's, up the
 * chain, so one label offset holds for the gate in every file's tree.
 */
export function canonicalGateId(
  gateId: string,
  tree: StoredHierarchy,
  trees: Record<string, StoredHierarchy>,
): string {
  let current: StoredHierarchy | undefined = tree;
  let id = gateId;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const mapped = current.source_gate_ids?.[id];
    if (!mapped || !current.source_hierarchy_id) break;
    id = mapped;
    current = trees[current.source_hierarchy_id];
  }
  return id;
}

/** The key a figure keeps a label offset under: the gate, and for a quadrant gate the quadrant too. */
export function figureLabelKey(canonicalGate: string, quadrant?: number): string {
  return quadrant === undefined ? canonicalGate : `${canonicalGate}#q${quadrant}`;
}

/** The overlay gates with the figure's own label offsets in place of the tree's. */
export function withFigureLabelOffsets<T extends { gate_id: string; label_offset?: unknown; quadrant_label_offsets?: unknown }>(
  gates: readonly T[],
  figure: Pick<FigureSpec, "labelOffsets">,
  tree: StoredHierarchy,
  trees: Record<string, StoredHierarchy>,
): T[] {
  const offsets = figure.labelOffsets;
  if (!offsets) return [...gates];
  return gates.map((gate) => {
    const key = canonicalGateId(gate.gate_id, tree, trees);
    const own = offsets[key];
    const quadrants = [0, 1, 2, 3].map((q) => offsets[figureLabelKey(key, q)] ?? null);
    const stored = Array.isArray(gate.quadrant_label_offsets) ? (gate.quadrant_label_offsets as ([number, number] | null)[]) : null;
    const quadrant_label_offsets = quadrants.some(Boolean)
      ? quadrants.map((q, i) => q ?? stored?.[i] ?? null)
      : undefined;
    return own || quadrant_label_offsets
      ? { ...gate, ...(own ? { label_offset: own } : {}), ...(quadrant_label_offsets ? { quadrant_label_offsets } : {}) }
      : gate;
  });
}

export function figureRanges(
  sources: readonly FigureSource[],
  figure: FigureSpec,
  /** The Gating tab's per-channel ranges; under the "gating" policy they replace the computed ones where set. */
  gatingRanges: Record<string, [number, number]> = {},
): Record<string, [number, number]> {
  const ranges: Record<string, [number, number]> = {};
  for (const source of sources)
    for (const key of Object.keys(figure.transforms)) {
      const idx = source.sample.index(key);
      if (idx === undefined) continue;
      const range = computeRangeFromValues(source.sample.displayColumn(idx));
      const old = ranges[key];
      ranges[key] = old
        ? [Math.min(old[0], range[0]), Math.max(old[1], range[1])]
        : range;
    }
  if (figure.scalePolicy === "gating") {
    for (const key of Object.keys(figure.transforms)) {
      const gating = gatingRanges[key];
      if (gating && gating[1] > gating[0]) ranges[key] = [gating[0], gating[1]];
    }
  }
  return ranges;
}

export function buildFigurePanel(
  panel: FigurePanel,
  figure: FigureSpec,
  sources: readonly FigureSource[],
  trees: Record<string, StoredHierarchy>,
  options: IllustrationOptions,
  sharedRanges: Record<string, [number, number]>,
  fullData = false,
): FigurePanelData {
  panel = {
    ...panel,
    samples: panel.samples.filter(
      (id) =>
        figurePopulationApplies(
          panel.population,
          sources.find((s) => s.id === id),
          trees,
          figure,
        ) ||
        panel.populations?.some((ref) =>
          figurePopulationApplies(
            ref,
            sources.find((s) => s.id === id),
            trees,
            figure,
          ),
        ),
    ),
  };
  if (!panel.samples.length)
    return { config: null, omitted: true, mappings: [] };
  if (panel.populations && panel.populations.length > 1) {
    if (panel.plot.type === "heatmap")
      return {
        config: null,
        mappings: [],
        problem: "Summary heatmaps need separate populations",
      };
    const parts = panel.populations.map((population) =>
      buildFigurePanel(
        { ...panel, population, populations: undefined },
        { ...figure, scalePolicy: "shared" },
        sources,
        trees,
        {
          ...options,
          maxEvents: fullData
            ? options.maxEvents
            : Math.max(
                1,
                Math.floor(options.maxEvents / panel.populations!.length),
              ),
        },
        sharedRanges,
        fullData,
      ),
    );
    const problem = parts.find((p) => p.problem);
    if (problem) return problem;
    const included = parts.flatMap((data, i) =>
      data.config ? [{ data, population: panel.populations![i] }] : [],
    );
    if (!included.length) return { config: null, omitted: true, mappings: [] };
    const colors = [
      "#2671c6",
      "#bc642c",
      "#69882b",
      "#8855a6",
      "#15938c",
      "#b74169",
    ];
    const traces = included
      .flatMap(({ data, population }) => {
        const cfg = data.config!,
          pop = population.label;
        const labels = (cfg.legend_entries ?? []) as { name: string }[];
        return [
          {
            x: cfg.x,
            y: cfg.y,
            name: labels[0] ? `${pop} · ${labels[0].name}` : pop,
          },
          ...(
            (cfg.overlay_traces ?? []) as {
              x: number[];
              y: number[];
              name: string;
            }[]
          ).map((t) => ({ ...t, name: `${pop} · ${t.name}` })),
        ];
      })
      .map((trace, i) => ({ ...trace, color: colors[i % colors.length] }));
    return {
      mappings: included.flatMap((p) => p.data.mappings),
      config: {
        ...included[0].data.config,
        x: traces[0].x,
        y: traces[0].y,
        pop_color: traces[0].color,
        overlay_traces: traces.slice(1),
        legend_entries: traces.map(({ name, color }) => ({ name, color })),
        gates: [],
        n_events: included.reduce(
          (n, p) => n + Number(p.data.config!.n_events),
          0,
        ),
        population_memberships: true,
      },
    };
  }
  const mappings: FigurePanelData["mappings"] = [];
  const results: {
    config: Record<string, unknown>;
    gates: unknown[];
    source: FigureSource;
  }[] = [];
  const summaryValues: number[] = [];
  let totalCount = 0;
  const resolve = (source: FigureSource) => {
    const override =
      figure.populationOverrides?.[source.id]?.[
        JSON.stringify([
          panel.population.hierarchyId,
          panel.population.populationId,
        ])
      ];
    return resolveFigurePopulation(
      override
        ? {
            hierarchyId: source.tree.id,
            populationId: override,
            label: panel.population.label,
          }
        : panel.population,
      source.tree,
      trees,
    );
  };
  const panelCount = panel.samples.reduce((n, id) => {
    const source = sources.find((s) => s.id === id);
    if (!source) return n;
    const resolved = resolve(source);
    return (
      n +
      (resolved.id ? (source.gating.stats.event_count[resolved.id] ?? 0) : 0)
    );
  }, 0);
  for (const id of panel.samples) {
    const source = sources.find((s) => s.id === id);
    if (!source)
      return { config: null, problem: "Sample unavailable", mappings };
    const resolved = resolve(source);
    mappings.push({ sample: source.name, status: resolved.status });
    if (!resolved.id)
      return {
        config: null,
        problem: `${source.name}: ${resolved.status === "ambiguous" ? "ambiguous population mapping" : "population missing"}`,
        mappings,
      };
    if (resolved.status === "changed")
      return {
        config: null,
        problem: `${source.name}: population structure changed — choose an explicit population for this plot`,
        mappings,
      };
    if (
      figure.samplePopulations &&
      !(figure.samplePopulations[id] ?? []).some(
        (ref) =>
          resolveFigurePopulation(ref, source.tree, trees).id === resolved.id,
      )
    ) {
      mappings.pop();
      continue;
    }
    const { x, y, type } = panel.plot;
    if (
      source.sample.index(x) === undefined ||
      (type === "biplot" && source.sample.index(y) === undefined)
    )
      return {
        config: null,
        problem: `${source.name}: channel unavailable`,
        mappings,
      };
    if (panel.samples.length > 1) {
      const reference = sources.find((s) => s.id === panel.samples[0]);
      if (
        reference &&
        (source.sample.activeLayer !== reference.sample.activeLayer ||
          [x, ...(type === "biplot" ? [y] : [])].some((key) => {
            const a = source.sample.channels[source.sample.index(key)!],
              ri = reference.sample.index(key),
              b = ri === undefined ? undefined : reference.sample.channels[ri];
            return !b || a.marker !== b.marker || a.pnn !== b.pnn;
          }))
      )
        return {
          config: null,
          problem:
            "Incompatible assay or channel identities — use separate panels",
          mappings,
        };
    }
    const count = source.gating.stats.event_count[resolved.id] ?? 0;
    totalCount += count;
    if (type === "heatmap") {
      if (figure.composition === "overlay")
        return {
          config: null,
          problem: "Summary heatmaps require separate panels or pooled events",
          mappings,
        };
      const column = source.sample.displayColumn(source.sample.index(x)!);
      const mask = source.gating.masks[resolved.id];
      for (let i = 0; i < column.length; i++)
        if (mask[i] && Number.isFinite(column[i]))
          summaryValues.push(column[i]);
      continue;
    }
    // A pooled preview samples proportionally to the full membership, not equally per file.
    const cap =
      figure.composition === "pool" &&
      !fullData &&
      Number.isFinite(options.maxEvents)
        ? Math.max(
            1,
            Math.floor((options.maxEvents * count) / Math.max(1, panelCount)),
          )
        : figure.composition === "overlay" && !fullData
          ? Math.max(1, Math.floor(options.maxEvents / panel.samples.length))
          : options.maxEvents;
    const result = buildIllustrationPayload(
      source.sample,
      source.tree.gates,
      source.tree.gate_order,
      source.tree.populations,
      source.gating.masks,
      source.gating.stats.event_count,
      [resolved.id],
      [x],
      type === "histogram" ? null : y,
      figure.scalePolicy !== "individual" || figure.composition !== "separate"
        ? sharedRanges
        : {},
      {
        ...options,
        maxEvents: cap,
        includeEmpty: true,
        pointBudget: fullData ? Infinity : 300_000,
      },
    );
    const key = `${resolved.id}|${x}`;
    const config = (result.plots as Record<string, Record<string, unknown>>)[
      key
    ];
    if (!config) {
      if (panel.samples.length > 1 && count === 0) continue;
      return { config: null, problem: "0 events in this population", mappings };
    }
    results.push({
      config,
      gates: withFigureLabelOffsets(
        ((result.gate_overlays as Record<string, unknown[]>)[key] ?? []) as { gate_id: string; label_offset?: unknown }[],
        figure,
        source.tree,
        trees,
      ),
      source,
    });
  }
  if (panel.plot.type === "heatmap")
    return {
      mappings,
      config: {
        figure_summary: summaryValues.length
          ? options.summaryStat === "mean"
            ? summaryValues.reduce((a, b) => a + b, 0) / summaryValues.length
            : exactMedian(summaryValues)
          : null,
        n_events: totalCount,
        x_label: panel.plot.name,
        x: [],
        y: [],
        summary_stat: options.summaryStat ?? "median",
      },
    };
  if (!results.length) return { config: null, omitted: true, mappings };
  const first = results[0];
  const colors = [
    "#2671c6",
    "#bc642c",
    "#69882b",
    "#8855a6",
    "#15938c",
    "#b74169",
  ];
  const pooled = figure.composition === "pool";
  const x = pooled
    ? results.flatMap((r) => r.config.x as number[])
    : first.config.x;
  const y = pooled
    ? results.flatMap((r) => r.config.y as number[])
    : first.config.y;
  return {
    mappings,
    config: {
      ...first.config,
      x,
      y,
      n_events: results.reduce((n, r) => n + Number(r.config.n_events), 0),
      population_label: panel.plot.population?.label,
      title: null,
      display_mode: options.displayMode,
      plot_size: figure.panelSize,
      point_size: options.pointSize,
      point_alpha: options.pointAlpha,
      density_color_power: options.densityColorPower,
      contour_threshold: options.contourThreshold,
      kde_bandwidth: options.kdeBandwidth,
      hist_line_width: options.histLineWidth,
      hist_fill: options.histFill,
      hist_fill_alpha: options.histFillAlpha,
      hist_overlay_mode: options.histOverlayMode,
      font_sizes: options.fontSizes,
      gate_style: {
        pub_style: options.pubStyle,
        line_width: options.gateLineWidth,
        gate_edge_mode: options.gateEdgeMode,
      },
      gates: figure.showGates && results.length === 1 ? first.gates : [],
      pop_color: results.length > 1 && !pooled ? colors[0] : "#444444",
      overlay_traces: pooled
        ? []
        : results.slice(1).map((r, i) => ({
            x: r.config.x,
            y: r.config.y,
            name: r.source.name,
            color: colors[(i + 1) % colors.length],
          })),
      legend_entries:
        pooled || results.length === 1
          ? []
          : results.map((r, i) => ({
              name: r.source.name,
              color: colors[i % colors.length],
            })),
    },
  };
}

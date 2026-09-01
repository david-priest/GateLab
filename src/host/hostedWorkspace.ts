import type {
  Gate,
  GateRef,
  GateSpace,
  GateTransforms,
  Population,
  PopulationMap,
  TransformSpec,
  Vertex,
} from "../engine/models";
import {
  migrateWorkspaceToV2,
  validateWorkspace,
  WORKSPACE_FORMAT,
  type WorkspaceFile,
  type WorkspaceSample,
} from "../engine/workspace";
import {
  WORKSPACE_VERSION_3,
  validateWorkspaceV3,
  type WorkspaceFileV3,
  type WorkspaceV3SampleRestoreContexts,
} from "../engine/workspaceV3";
import type { Sample } from "../engine/sample";
import type { GateLabHostDatasetDescriptor } from "./datasetContract";
import type {
  GateLabHostWorkspaceEnvelope,
  GateLabHostWorkspaceSource,
} from "./workspaceContract";

type GateValueSpace = "raw" | "display";

export interface HostedWorkspaceRestore {
  workspace: WorkspaceFile | WorkspaceFileV3;
  sourceFormat: GateLabHostWorkspaceSource;
  sourceGateSpace: GateValueSpace | null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`Saved GateLabR workspace has invalid ${label}.`);
}

function recordOrEmpty(value: unknown, label: string): Record<string, unknown> {
  if (Array.isArray(value) && value.length === 0) return {};
  if (value === undefined || value === null) return {};
  return record(value, label);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("Saved GateLabR workspace contains a malformed ID list.");
  }
  return [...value];
}

function pair(value: unknown, label: string): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  ) {
    throw new Error(`Saved GateLabR workspace has invalid ${label}.`);
  }
  return [value[0], value[1]];
}

/**
 * The numeric parameters each transform kind carries. Keying this by `TransformSpec["kind"]`
 * makes a new kind in models.ts a type error here rather than a field silently dropped.
 */
const TRANSFORM_PARAMETERS: Record<TransformSpec["kind"], readonly string[]> = {
  identity: [],
  asinh: ["cofactor"],
  logicle: ["T", "W", "M", "A"],
  biex: ["maxValue", "pos", "neg", "widthBasis", "channelRange"],
  wsplog: ["offset", "decades"],
};

function transformSpec(value: unknown, label: string): TransformSpec {
  const source = record(value, label);
  const kind = stringValue(source.kind);
  if (!(kind in TRANSFORM_PARAMETERS)) {
    throw new Error(`Saved GateLabR workspace has an unsupported ${label}.`);
  }
  const spec: Record<string, unknown> = { kind };
  for (const parameter of TRANSFORM_PARAMETERS[kind as TransformSpec["kind"]]) {
    const number = finiteNumber(source[parameter]);
    if (number === null) {
      throw new Error(`Saved GateLabR workspace has an invalid ${label}.`);
    }
    spec[parameter] = number;
  }
  return spec as TransformSpec;
}

/**
 * The space a gate's parameters are straight in, and the transforms it was drawn under.
 *
 * Both are optional on every gate type, and absent means the sample's pre-field default -- but
 * dropping them when they ARE present re-reads the gate in a different space, so the same
 * coordinates select a different event set with nothing on screen to say so. An ellipse is
 * always created in display space with its axis transforms captured (a screen ellipse is not an
 * ellipse in raw space), so it is the type that loses meaning most readily; the fields belong to
 * every gate, which is why this sits in the shared part of normalizeGate rather than one branch.
 *
 * Malformed transforms throw rather than being skipped: restoring the gate as though it had none
 * is the very silent-mismatch this exists to prevent.
 */
function gateSpaceFields(
  source: Record<string, unknown>,
  gateName: string,
): { space?: GateSpace; transforms?: GateTransforms } {
  const space = source.space;
  if (space === undefined || space === null) return {};
  if (space !== "raw" && space !== "display") {
    throw new Error(`Saved GateLabR gate '${gateName}' has an unsupported gate space.`);
  }
  const entries = recordOrEmpty(source.transforms, `transforms for gate '${gateName}'`);
  const transforms: GateTransforms = {};
  for (const [channel, spec] of Object.entries(entries)) {
    transforms[channel] = transformSpec(spec, `transform for gate '${gateName}'`);
  }
  return Object.keys(transforms).length > 0 ? { space, transforms } : { space };
}

function vertices(value: unknown, gateName: string): Vertex[] {
  if (!Array.isArray(value)) {
    throw new Error(`Saved GateLabR gate '${gateName}' has invalid vertices.`);
  }
  return value.map((entry) => pair(entry, `vertices for gate '${gateName}'`));
}

function normalizeGate(value: unknown, gateId: string, index: number): Gate {
  const source = record(value, `gate '${gateId}'`);
  const name = stringValue(source.name, gateId);
  const common = {
    gate_id: stringValue(source.gate_id, gateId),
    name,
    x_channel: stringValue(source.x_channel),
    y_channel: stringValue(source.y_channel),
    color: stringValue(source.color, [
      "#e41a1c", "#377eb8", "#4daf4a", "#984ea3", "#ff7f00",
      "#a65628", "#f781bf", "#999999", "#e6ab02", "#66c2a5",
    ][index % 10]),
    label_offset: source.label_offset === null || source.label_offset === undefined
      ? null
      : pair(source.label_offset, `label offset for gate '${name}'`),
    ...gateSpaceFields(source, name),
  };
  if (source.gate_type === "quadrant") {
    return {
      ...common,
      gate_type: "quadrant",
      center: pair(source.center, `centre for gate '${name}'`),
    };
  }
  if (source.gate_type === "ellipse") {
    // The R mirror writes the covariance form plus a sampled boundary. The parameters are the
    // record -- rebuilding from the boundary would quietly turn the ellipse into a 64-gon.
    const cov = source.covariance;
    if (!Array.isArray(cov) || cov.length !== 2) {
      throw new Error(`Saved GateLabR gate '${name}' has an invalid covariance matrix.`);
    }
    const rows = cov.map((row) => pair(row, `covariance for gate '${name}'`));
    const distanceSquare = finiteNumber(source.distance_square);
    if (distanceSquare === null || distanceSquare <= 0) {
      throw new Error(`Saved GateLabR gate '${name}' has an invalid distance_square.`);
    }
    return {
      ...common,
      gate_type: "ellipse",
      mean: pair(source.mean, `mean for gate '${name}'`),
      covariance: [rows[0], rows[1]],
      distance_square: distanceSquare,
    };
  }
  if (source.gate_type !== "rectangle" && source.gate_type !== "polygon") {
    throw new Error(`Saved GateLabR gate '${name}' has an unsupported type.`);
  }
  return {
    ...common,
    gate_type: source.gate_type,
    vertices: vertices(source.vertices, name),
  };
}

function normalizeGateRef(value: unknown): GateRef {
  const source = record(value, "gate reference");
  const quadrant = finiteNumber(source.quadrant);
  return {
    gate_id: stringValue(source.gate_id),
    include: typeof source.include === "boolean" ? source.include : true,
    ...(quadrant !== null ? { quadrant } : {}),
  };
}

function objectArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return [value];
  throw new Error("Saved GateLabR workspace contains a malformed object list.");
}

function normalizePopulation(value: unknown, populationId: string): Population {
  const source = record(value, `population '${populationId}'`);
  const eventCount = finiteNumber(source.event_count);
  const percentOfParent = finiteNumber(source.percent_of_parent);
  const colorSlot = finiteNumber(source.colorSlot);
  return {
    population_id: stringValue(source.population_id, populationId),
    name: stringValue(source.name, populationId),
    gate_refs: objectArray(source.gate_refs).map(normalizeGateRef),
    gate_logic: source.gate_logic === "or" ? "or" : "and",
    parent_id: nullableString(source.parent_id),
    children: stringArray(source.children),
    event_count: eventCount,
    percent_of_parent: percentOfParent,
    ...(colorSlot !== null && Number.isInteger(colorSlot) && colorSlot >= 0
      ? { colorSlot }
      : {}),
  };
}

function normalizeScales(value: unknown): Record<string, [number, number]> {
  const result: Record<string, [number, number]> = {};
  for (const [channel, candidate] of Object.entries(
    recordOrEmpty(value, "global scale ranges"),
  )) {
    const range = pair(candidate, `scale range for '${channel}'`);
    if (range[1] > range[0]) result[channel] = range;
  }
  return result;
}

function hostedSamples(
  dataset: GateLabHostDatasetDescriptor,
  existing: readonly WorkspaceSample[] = [],
): WorkspaceSample[] {
  return dataset.samples.map((sample, index) => {
    const prior = existing.find(
      (candidate) =>
        candidate.sampleId === `${dataset.id}:${sample.id}` ||
        candidate.fileName === sample.label,
    ) ?? existing[index];
    return {
      ...(prior ?? {}),
      sampleId: `${dataset.id}:${sample.id}`,
      fileName: sample.label || `SCE sample ${index + 1}`,
      dataPath: `data/sce-${index + 1}.fcs`,
      logicleW: prior?.logicleW ?? {},
      compensationOn: prior?.compensationOn ?? false,
      ...(dataset.instrument === "flow" || dataset.instrument === "cytof"
        ? { instrumentMode: dataset.instrument }
        : {}),
    };
  });
}

function remapCanonicalWorkspace(
  workspace: WorkspaceFile,
  dataset: GateLabHostDatasetDescriptor,
): WorkspaceFile {
  const samples = hostedSamples(dataset, workspace.samples);
  const remapped: WorkspaceFile = {
    ...workspace,
    samples,
    activeSample: Math.min(Math.max(0, workspace.activeSample), samples.length - 1),
  };
  validateWorkspace(remapped);
  return remapped;
}

function remapCanonicalWorkspaceV3(
  workspace: WorkspaceFileV3,
  dataset: GateLabHostDatasetDescriptor,
): WorkspaceFileV3 {
  const samples = dataset.samples.map((sample, index) => {
    const prior = workspace.samples.find(
      (candidate) =>
        candidate.sampleId === `${dataset.id}:${sample.id}` ||
        candidate.fileName === sample.label,
    ) ?? workspace.samples[index];
    if (!prior) {
      throw new Error(
        `Saved GateLab workspace has no assay state for '${sample.label}'.`,
      );
    }
    return {
      ...prior,
      sampleId: `${dataset.id}:${sample.id}`,
      fileName: sample.label || `SCE sample ${index + 1}`,
      dataPath: `data/sce-${index + 1}.fcs`,
      ...(dataset.instrument === "flow" || dataset.instrument === "cytof"
        ? { instrumentMode: dataset.instrument }
        : {}),
    };
  });
  return {
    ...workspace,
    samples,
    activeSample: Math.min(
      Math.max(0, workspace.activeSample),
      samples.length - 1,
    ),
  };
}

function translateLegacyWorkspace(
  raw: unknown,
  dataset: GateLabHostDatasetDescriptor,
): HostedWorkspaceRestore {
  const source = record(raw, "workspace payload");
  const gates: Record<string, Gate> = {};
  Object.entries(recordOrEmpty(source.gates, "gate map")).forEach(
    ([gateId, gate], index) => {
      gates[gateId] = normalizeGate(gate, gateId, index);
    },
  );
  const populations: PopulationMap = {};
  for (const [populationId, population] of Object.entries(
    record(source.populations, "population map"),
  )) {
    populations[populationId] = normalizePopulation(population, populationId);
  }
  const rootId = stringValue(source.root_population_id);
  const firstX = dataset.channels[0]?.id ?? "";
  const firstY = dataset.channels[1]?.id ?? firstX;
  const globalScales = normalizeScales(
    source.global_scale_ranges ?? source.cytof_axis_range,
  );
  const activePopulation = nullableString(source.active_population_id);
  const selectedGate = nullableString(source.selected_gate_id);
  const samples = hostedSamples(dataset);
  const workspace: WorkspaceFile = {
    format: WORKSPACE_FORMAT,
    version: 2,
    workspaceId: `sce:${dataset.id}`,
    savedAt: stringValue(source.saved_at),
    app: "GateLabR",
    samples,
    activeSample: 0,
    gating: {
      gates,
      gate_order: stringArray(source.gate_order),
      populations,
      root_population_id: rootId,
      active_population_id: activePopulation && populations[activePopulation]
        ? activePopulation
        : rootId,
      selected_gate_id: selectedGate && gates[selectedGate] ? selectedGate : null,
    },
    scales: { globalScales },
    display: {
      xChannel: firstX,
      yChannel: firstY,
      mode: "pseudocolor",
      maxEvents: 50000,
      contourThreshold: 5,
    },
  };
  validateWorkspace(workspace);
  const gateSpace = source.gate_value_space;
  return {
    workspace,
    sourceFormat: "gatelabr-legacy",
    sourceGateSpace: gateSpace === "raw" || gateSpace === "display"
      ? gateSpace
      : null,
  };
}

export async function readHostedWorkspace(
  envelope: GateLabHostWorkspaceEnvelope,
  dataset: GateLabHostDatasetDescriptor,
  hostedSamplesForValidation: readonly Sample[] = [],
): Promise<HostedWorkspaceRestore> {
  let raw: unknown;
  try {
    raw = JSON.parse(envelope.workspaceJson);
  } catch {
    throw new Error("The SCE contains unreadable GateLab workspace metadata.");
  }
  if (envelope.sourceFormat === "gatelabr-legacy") {
    return translateLegacyWorkspace(raw, dataset);
  }
  if (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    (raw as { version?: unknown }).version === WORKSPACE_VERSION_3
  ) {
    const rawSamples = Array.isArray((raw as { samples?: unknown }).samples)
      ? (raw as { samples: Array<{ dataPath?: unknown }> }).samples
      : [];
    const contexts: WorkspaceV3SampleRestoreContexts = Object.freeze(
      Object.fromEntries(rawSamples.flatMap((workspaceSample, index) => {
        const runtimeSample = hostedSamplesForValidation[index];
        return runtimeSample && typeof workspaceSample?.dataPath === "string"
          ? [[workspaceSample.dataPath, Object.freeze({
              sampleChannels: runtimeSample.channels,
              instrumentKind: runtimeSample.instrument,
            })]]
          : [];
      })),
    );
    const canonical = await validateWorkspaceV3(raw, contexts);
    const sourceInstrument = canonical.samples[0]?.instrumentMode;
    return {
      workspace: remapCanonicalWorkspaceV3(canonical, dataset),
      sourceFormat: "gatelab-workspace",
      sourceGateSpace: sourceInstrument === "flow"
        ? "raw"
        : sourceInstrument === "cytof"
          ? "display"
          : null,
    };
  }
  const canonical = migrateWorkspaceToV2(raw);
  validateWorkspace(canonical);
  const sourceInstrument = canonical.samples[0]?.instrumentMode;
  return {
    workspace: remapCanonicalWorkspace(canonical, dataset),
    sourceFormat: "gatelab-workspace",
    sourceGateSpace: sourceInstrument === "flow"
      ? "raw"
      : sourceInstrument === "cytof"
        ? "display"
        : null,
  };
}

export function convertHostedGateSpace<
  TWorkspace extends WorkspaceFile | WorkspaceFileV3,
>(
  workspace: TWorkspace,
  sample: Sample,
  sourceGateSpace: GateValueSpace | null,
): TWorkspace {
  const targetGateSpace = sample.gatingSpace;
  if (sourceGateSpace === null || sourceGateSpace === targetGateSpace) {
    return workspace;
  }
  const convert = (channel: string, value: number): number =>
    sourceGateSpace === "display"
      ? sample.displayToGating(channel, value)
      : sample.rawToDisplay(channel, value);
  const gates = Object.fromEntries(
    Object.entries(workspace.gating.gates).map(([gateId, gate]) => {
      if (gate.gate_type === "quadrant") {
        return [gateId, {
          ...gate,
          center: [
            convert(gate.x_channel, gate.center[0]),
            convert(gate.y_channel, gate.center[1]),
          ] as Vertex,
        }];
      }
      // An ellipse under a nonlinear space change is not an ellipse, so this legacy converter
      // cannot move one — and never needs to: ellipses postdate the per-gate space field, so a
      // pre-space-field workspace (the only thing this converter exists for) cannot hold one.
      // Passing it through unchanged is exact.
      if (gate.gate_type === "ellipse") return [gateId, gate];
      return [gateId, {
        ...gate,
        vertices: gate.vertices.map(([x, y]) => [
          convert(gate.x_channel, x),
          convert(gate.y_channel, y),
        ] as Vertex),
      }];
    }),
  );
  const converted = {
    ...workspace,
    gating: { ...workspace.gating, gates },
  } as TWorkspace;
  if (converted.version === 2) validateWorkspace(converted);
  return converted;
}

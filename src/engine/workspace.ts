// workspace.ts — GateLab session persistence. A `.gatelab` file is either a ZIP bundle
// (workspace.json + data/<name>.fcs per sample + optional gates.gatingml.xml) or a lightweight
// reference JSON (workspace.json only; the FCS files live on disk, re-linked on open). Both
// hold MULTIPLE samples sharing one gating tree — GateLab's self-contained analog of GateLabR's
// SCE-with-metadata. Reopening re-parses the FCS (bit-identical) and reapplies the JSON state.

import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import type { Gate, PopulationMap } from "./models";
import type { DisplayMode } from "./sample";

export const WORKSPACE_EXT = "gatelab";
export const WORKSPACE_FORMAT = "gatelab-workspace";
export type WorkspaceStorage = "bundle" | "reference";

export interface GatingFontSizes {
  tick: number;
  axis: number;
  title: number;
  gate: number;
}

export interface WorkspaceSample {
  fileName: string;
  dataPath: string; // unique in-zip path (e.g. "data/0_run.fcs"); also the bundle lookup key
  logicleW: Record<string, number>; // per-sample user W overrides
  scatterCofactor?: Record<string, number>; // per-sample flow-scatter arcsinh cofactors
  cytofCofactor?: number; // per-sample global CyTOF arcsinh cofactor
  compensationOn: boolean; // per-sample
  instrumentMode?: "auto" | "flow" | "cytof"; // per-sample instrument override ('auto' = detected)
  labels?: Record<string, string>; // Panel-tab channel display names, keyed by identity key
  metadata?: Record<string, string>; // per-sample metadata fields (Metadata tab)
  division?: { channelKey: string; boundaries: number[]; n: number; colName: string; coordinateBindingKey?: string }; // Division profile
}

export interface WorkspaceFile {
  format: typeof WORKSPACE_FORMAT;
  version: 2;
  /** Stable lineage ID for browser-local checkpoints; optional for older workspaces. */
  workspaceId?: string;
  savedAt: string;
  app: string;
  samples: WorkspaceSample[];
  activeSample: number; // index into samples
  gating: {
    gates: Record<string, Gate>;
    gate_order: string[];
    populations: PopulationMap;
    root_population_id: string | null;
    active_population_id: string | null;
    selected_gate_id: string | null;
  };
  scales: { globalScales: Record<string, [number, number]> }; // shared per-channel axis ranges
  display: {
    xChannel: string;
    yChannel: string;
    mode: DisplayMode;
    maxEvents: number;
    contourThreshold: number;
    /** Main Gating plot typography. Optional for workspaces saved before these controls existed. */
    fontSizes?: GatingFontSizes;
  };
  /** Illustration-tab settings + named presets (capture_illust_settings / illust_presets). */
  illustration?: IllustrationConfig;
  illustrationPresets?: IllustrationPreset[];
  /** Ordered metadata field columns (names + optional categorical level order). Shared. */
  metadataColumns?: { name: string; levels?: string[] }[];
  /** Population annotation (Metadata tab, 2nd table): keyed by population_id → { field: value }. */
  populationMetadata?: Record<string, Record<string, string>>;
  populationMetaColumns?: { name: string; levels?: string[] }[];
}

/** Illustration-tab configuration (capture_illust_settings) — persisted per-workspace + as presets. */
export interface IllustrationConfig {
  /** Explicit plot family. Optional so workspaces saved before heatmaps remain valid. */
  plotType?: "biplot" | "histogram" | "heatmap";
  popIds: string[];
  xChannels: string[];
  yChannel: string;
  displayMode: string;
  plotSize: number;
  nColumns: number;
  fitToColumns: boolean;
  maxEvents: number;
  allEvents: boolean;
  colorByPop: boolean;
  overlayPops: boolean;
  popColors: Record<string, string>;
  pointSize: number;
  pointAlpha: number;
  contourThreshold: number;
  kdeBandwidth: number;
  pubStyle: boolean;
  gateLineWidth: number;
  histLineWidth: number;
  histFill: boolean;
  histFillAlpha: number;
  histOverlayMode: string;
  histLayout: string;
  ridgeOverlap: number;
  ridgeColGap: number;
  ridgeGradient: boolean;
  heatmapStat?: "median" | "mean";
  heatmapScale?: "none" | "column_minmax" | "row_minmax" | "column_zscore";
  heatmapPalette?: "heat" | "viridis" | "blue_white_yellow_red";
  heatmapCellSize?: number;
  heatmapShowValues?: boolean;
  fontTick: number;
  fontAxis: number;
  fontTitle: number;
  fontGate: number;
  /** Scale the base font sizes with panel/cell size. Optional for older workspaces. */
  scaleFontsWithPlot?: boolean;
}

export interface IllustrationPreset {
  name: string;
  config: IllustrationConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidWorkspace(detail: string): never {
  throw new Error(`Invalid GateLab workspace: ${detail}`);
}

function finitePair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "number" && Number.isFinite(v));
}

function positiveNumericRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.entries(value).every(
    ([key, entry]) => key.length > 0 && typeof entry === "number" && Number.isFinite(entry) && entry > 0,
  );
}

const DIVISION_PROFILE_KEYS = new Set([
  "channelKey",
  "boundaries",
  "n",
  "colName",
  "coordinateBindingKey",
]);

function validateDivisionProfile(value: unknown, sampleIndex: number): void {
  const label = `sample ${sampleIndex + 1} division profile`;
  if (!isRecord(value)) invalidWorkspace(`${label} is not an object.`);
  const extra = Object.keys(value).filter((key) => !DIVISION_PROFILE_KEYS.has(key));
  if (extra.length > 0) {
    invalidWorkspace(`${label} has unexpected fields: ${extra.join(", ")}.`);
  }
  if (typeof value.channelKey !== "string" || value.channelKey.trim().length === 0) {
    invalidWorkspace(`${label} has an invalid channelKey.`);
  }
  if (typeof value.colName !== "string" || value.colName.trim().length === 0) {
    invalidWorkspace(`${label} has an invalid colName.`);
  }
  if (!Number.isInteger(value.n) || (value.n as number) < 1 || (value.n as number) > 11) {
    invalidWorkspace(`${label} must have an integer n from 1 to 11.`);
  }
  if (!Array.isArray(value.boundaries)) {
    invalidWorkspace(`${label} boundaries must be an array.`);
  }
  const boundaries = value.boundaries as unknown[];
  if (boundaries.length !== value.n) {
    invalidWorkspace(`${label} boundary count must equal n.`);
  }
  for (let i = 0; i < boundaries.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(boundaries, i) ||
        typeof boundaries[i] !== "number" || !Number.isFinite(boundaries[i])) {
      invalidWorkspace(`${label} boundaries must be dense finite numbers.`);
    }
    if (i > 0 && (boundaries[i] as number) <= (boundaries[i - 1] as number)) {
      invalidWorkspace(`${label} boundaries must be strictly increasing.`);
    }
  }
  if (value.coordinateBindingKey !== undefined &&
      (typeof value.coordinateBindingKey !== "string" || value.coordinateBindingKey.trim().length === 0)) {
    invalidWorkspace(`${label} has an invalid coordinateBindingKey.`);
  }
}

/**
 * Validate the persisted gating graph before it can be saved or applied.
 *
 * A dangling gate reference or inconsistent parent/children link changes population
 * membership rather than merely affecting presentation, so corrupt graphs are rejected
 * instead of being partially interpreted.
 */
export function validateWorkspace(ws: WorkspaceFile): true {
  if (!isRecord(ws)) invalidWorkspace("the workspace payload is not an object.");
  if (ws.format !== WORKSPACE_FORMAT || ws.version !== 2) {
    invalidWorkspace("unsupported format or version.");
  }
  if (ws.workspaceId !== undefined && (typeof ws.workspaceId !== "string" || ws.workspaceId.trim().length === 0)) {
    invalidWorkspace("workspaceId must be a non-empty string when present.");
  }
  if (!Array.isArray(ws.samples) || ws.samples.length === 0) {
    invalidWorkspace("at least one sample is required.");
  }

  const dataPaths = new Set<string>();
  ws.samples.forEach((sample, i) => {
    if (!isRecord(sample)) invalidWorkspace(`sample ${i + 1} is not an object.`);
    if (typeof sample.fileName !== "string" || sample.fileName.trim().length === 0) {
      invalidWorkspace(`sample ${i + 1} has no file name.`);
    }
    if (typeof sample.dataPath !== "string" || !sample.dataPath.startsWith("data/") ||
        sample.dataPath.split("/").some((part) => part === "" || part === "..")) {
      invalidWorkspace(`sample ${i + 1} has an unsafe or empty dataPath.`);
    }
    if (dataPaths.has(sample.dataPath)) invalidWorkspace(`duplicate sample dataPath "${sample.dataPath}".`);
    dataPaths.add(sample.dataPath);
    if (!isRecord(sample.logicleW) || typeof sample.compensationOn !== "boolean") {
      invalidWorkspace(`sample ${i + 1} has invalid transform or compensation settings.`);
    }
    if (sample.scatterCofactor !== undefined && !positiveNumericRecord(sample.scatterCofactor)) {
      invalidWorkspace(`sample ${i + 1} has invalid scatter cofactors.`);
    }
    if (sample.cytofCofactor !== undefined &&
        (typeof sample.cytofCofactor !== "number" || !Number.isFinite(sample.cytofCofactor) || sample.cytofCofactor <= 0)) {
      invalidWorkspace(`sample ${i + 1} has an invalid CyTOF cofactor.`);
    }
    if (
      sample.instrumentMode !== undefined &&
      sample.instrumentMode !== "auto" &&
      sample.instrumentMode !== "flow" &&
      sample.instrumentMode !== "cytof"
    ) {
      invalidWorkspace(`sample ${i + 1} has an invalid instrument mode.`);
    }
    if (sample.division !== undefined) validateDivisionProfile(sample.division, i);
  });
  if (!Number.isInteger(ws.activeSample) || ws.activeSample < 0 || ws.activeSample >= ws.samples.length) {
    invalidWorkspace("activeSample is outside the sample list.");
  }

  if (!isRecord(ws.scales) || !isRecord(ws.scales.globalScales)) {
    invalidWorkspace("shared scale settings are missing or invalid.");
  }
  for (const [channel, range] of Object.entries(ws.scales.globalScales)) {
    if (!channel || !finitePair(range) || range[1] <= range[0]) {
      invalidWorkspace(`shared scale for "${channel}" is invalid.`);
    }
  }
  if (!isRecord(ws.display) || typeof ws.display.xChannel !== "string" || typeof ws.display.yChannel !== "string" ||
      !["pseudocolor", "dots", "contour"].includes(ws.display.mode) ||
      !Number.isFinite(ws.display.maxEvents) || ws.display.maxEvents < 0 ||
      !Number.isFinite(ws.display.contourThreshold)) {
    invalidWorkspace("display settings are missing or invalid.");
  }
  if (ws.display.fontSizes !== undefined && (
    !isRecord(ws.display.fontSizes) ||
    !["tick", "axis", "title", "gate"].every((key) => {
      const size = ws.display.fontSizes?.[key as keyof GatingFontSizes];
      return typeof size === "number" && Number.isFinite(size) && size >= 6 && size <= 72;
    })
  )) {
    invalidWorkspace("gating font sizes are invalid.");
  }

  if (!isRecord(ws.gating)) invalidWorkspace("gating state is missing.");
  const gates = ws.gating.gates;
  const populations = ws.gating.populations;
  if (!isRecord(gates)) invalidWorkspace("gates must be an object keyed by gate_id.");
  if (!isRecord(populations)) invalidWorkspace("populations must be an object keyed by population_id.");

  const gateIds = Object.keys(gates);
  for (const [gateId, value] of Object.entries(gates)) {
    if (!isRecord(value)) invalidWorkspace(`gate "${gateId}" is not an object.`);
    const gate = value as unknown as Gate;
    if (gate.gate_id !== gateId) invalidWorkspace(`gate map key "${gateId}" does not match its gate_id.`);
    if (typeof gate.name !== "string" || gate.name.trim().length === 0) invalidWorkspace(`gate "${gateId}" has no name.`);
    if (typeof gate.x_channel !== "string" || !gate.x_channel || typeof gate.y_channel !== "string" || !gate.y_channel) {
      invalidWorkspace(`gate "${gateId}" has invalid channel identifiers.`);
    }
    if (gate.gate_type === "polygon" || gate.gate_type === "rectangle") {
      const minVertices = gate.gate_type === "polygon" ? 3 : 2;
      if (!Array.isArray(gate.vertices) || gate.vertices.length < minVertices || !gate.vertices.every(finitePair)) {
        invalidWorkspace(`${gate.gate_type} gate "${gateId}" has invalid geometry.`);
      }
    } else if (gate.gate_type === "quadrant") {
      if (!finitePair(gate.center)) invalidWorkspace(`quadrant gate "${gateId}" has an invalid center.`);
    } else {
      invalidWorkspace(`gate "${gateId}" has unsupported gate_type "${String((gate as { gate_type?: unknown }).gate_type)}".`);
    }
  }

  const order = ws.gating.gate_order;
  if (!Array.isArray(order) || !order.every((id) => typeof id === "string")) {
    invalidWorkspace("gate_order must be an array of gate IDs.");
  }
  if (new Set(order).size !== order.length) invalidWorkspace("gate_order contains duplicate IDs.");
  const gateSet = new Set(gateIds);
  const orderSet = new Set(order);
  const missingFromOrder = gateIds.filter((id) => !orderSet.has(id));
  const unknownInOrder = order.filter((id) => !gateSet.has(id));
  if (missingFromOrder.length || unknownInOrder.length) {
    invalidWorkspace(
      `gate_order does not match the gate map` +
      `${missingFromOrder.length ? ` (missing: ${missingFromOrder.join(", ")})` : ""}` +
      `${unknownInOrder.length ? ` (unknown: ${unknownInOrder.join(", ")})` : ""}.`,
    );
  }

  const rootId = ws.gating.root_population_id;
  if (typeof rootId !== "string" || rootId.length === 0 || !populations[rootId]) {
    invalidWorkspace("root_population_id is missing or does not identify a population.");
  }

  const popIds = Object.keys(populations);
  for (const [popId, value] of Object.entries(populations)) {
    if (!isRecord(value)) invalidWorkspace(`population "${popId}" is not an object.`);
    const pop = value as unknown as PopulationMap[string];
    if (pop.population_id !== popId) invalidWorkspace(`population map key "${popId}" does not match its population_id.`);
    if (typeof pop.name !== "string" || pop.name.trim().length === 0) invalidWorkspace(`population "${popId}" has no name.`);
    if (pop.gate_logic !== "and" && pop.gate_logic !== "or") invalidWorkspace(`population "${popId}" has invalid gate_logic.`);
    if (!Array.isArray(pop.children) || !pop.children.every((id) => typeof id === "string")) {
      invalidWorkspace(`population "${popId}" has invalid children.`);
    }
    if (new Set(pop.children).size !== pop.children.length) invalidWorkspace(`population "${popId}" lists a child more than once.`);
    if (!Array.isArray(pop.gate_refs)) invalidWorkspace(`population "${popId}" has invalid gate_refs.`);

    if (popId === rootId) {
      if (pop.parent_id !== null) invalidWorkspace("the root population must have parent_id = null.");
      if (pop.gate_refs.length) invalidWorkspace("the root population cannot contain gate references.");
    } else if (typeof pop.parent_id !== "string" || !populations[pop.parent_id]) {
      invalidWorkspace(`population "${popId}" has a missing parent.`);
    } else if (pop.parent_id === popId) {
      invalidWorkspace(`population "${popId}" cannot be its own parent.`);
    }

    for (const childId of pop.children) {
      const child = populations[childId];
      if (!child) invalidWorkspace(`population "${popId}" refers to missing child "${childId}".`);
      if (child.parent_id !== popId) invalidWorkspace(`parent/child links disagree for population "${childId}".`);
    }

    for (const ref of pop.gate_refs) {
      if (!isRecord(ref) || typeof ref.gate_id !== "string" || !gates[ref.gate_id]) {
        invalidWorkspace(`population "${popId}" has a dangling gate reference.`);
      }
      if (typeof ref.include !== "boolean") invalidWorkspace(`population "${popId}" has a gate reference without a boolean include value.`);
      const gate = gates[ref.gate_id];
      if (gate.gate_type === "quadrant") {
        if (!Number.isInteger(ref.quadrant) || ref.quadrant! < 1 || ref.quadrant! > 4) {
          invalidWorkspace(`population "${popId}" has an invalid quadrant reference.`);
        }
      } else if (ref.quadrant !== undefined && ref.quadrant !== null) {
        invalidWorkspace(`population "${popId}" assigns a quadrant to a non-quadrant gate.`);
      }
    }
  }

  for (const popId of popIds) {
    if (popId === rootId) continue;
    const parentId = populations[popId].parent_id!;
    if (!populations[parentId].children.includes(popId)) {
      invalidWorkspace(`population "${popId}" is absent from its parent's children list.`);
    }
  }

  const reached = new Set<string>();
  const visiting = new Set<string>();
  const walk = (popId: string): void => {
    if (visiting.has(popId)) invalidWorkspace(`population hierarchy contains a cycle at "${popId}".`);
    if (reached.has(popId)) return;
    visiting.add(popId);
    for (const childId of populations[popId].children) walk(childId);
    visiting.delete(popId);
    reached.add(popId);
  };
  walk(rootId);
  const unreachable = popIds.filter((id) => !reached.has(id));
  if (unreachable.length) invalidWorkspace(`population hierarchy contains unreachable nodes: ${unreachable.join(", ")}.`);

  const activePop = ws.gating.active_population_id;
  if (activePop !== null && (typeof activePop !== "string" || !populations[activePop])) {
    invalidWorkspace("active_population_id does not identify a population.");
  }
  const selectedGate = ws.gating.selected_gate_id;
  if (selectedGate !== null && (typeof selectedGate !== "string" || !gates[selectedGate])) {
    invalidWorkspace("selected_gate_id does not identify a gate.");
  }
  return true;
}

/** Pack workspace JSON + each sample's FCS bytes (keyed by dataPath) into a bundled .gatelab zip. */
export function packWorkspace(
  ws: WorkspaceFile,
  fcsByPath: Record<string, Uint8Array>,
  gatingMLXml?: string,
): Uint8Array {
  validateWorkspace(ws);
  const files: Record<string, Uint8Array> = { "workspace.json": strToU8(JSON.stringify(ws, null, 2)) };
  for (const sample of ws.samples) {
    const bytes = fcsByPath[sample.dataPath];
    if (!(bytes instanceof Uint8Array)) {
      invalidWorkspace(`bundled FCS data is missing for "${sample.fileName}" (${sample.dataPath}).`);
    }
    files[sample.dataPath] = bytes;
  }
  if (gatingMLXml) files["gates.gatingml.xml"] = strToU8(gatingMLXml);
  return zipSync(files, { level: 6 });
}

/** A lightweight reference workspace — JSON only; the FCS files are re-linked from disk on open. */
export function packWorkspaceReference(ws: WorkspaceFile): Uint8Array {
  validateWorkspace(ws);
  return strToU8(JSON.stringify(ws, null, 2));
}

/** Re-save a workspace without silently changing its storage format. */
export function packWorkspaceForStorage(
  ws: WorkspaceFile,
  fcsByPath: Record<string, Uint8Array>,
  storage: WorkspaceStorage,
  gatingMLXml?: string,
): Uint8Array {
  return storage === "bundle"
    ? packWorkspace(ws, fcsByPath, gatingMLXml)
    : packWorkspaceReference(ws);
}

/**
 * Migrate only the explicitly supported v1/v2 formats to the live v2 model.
 * A samples-shaped future workspace must never be mistaken for current state.
 */
export function migrateWorkspaceToV2(raw: unknown): WorkspaceFile {
  if (!isRecord(raw) || raw.format !== WORKSPACE_FORMAT) {
    throw new Error("Unrecognized workspace format.");
  }
  const r = raw as Record<string, unknown>;
  if (r.version === 2) return raw as unknown as WorkspaceFile;
  if (r.version !== 1) {
    throw new Error(
      `Unsupported GateLab workspace version '${String(r.version)}'; this app can open versions 1 and 2.`,
    );
  }
  // v1 (single sample) → v2
  const s1 = (r.sample ?? {}) as { fileName?: string; dataPath?: string };
  const scales = (r.scales ?? {}) as { logicleW?: Record<string, number>; globalScales?: Record<string, [number, number]> };
  const comp = (r.compensation ?? {}) as { on?: boolean };
  return {
    format: WORKSPACE_FORMAT,
    version: 2,
    workspaceId: typeof r.workspaceId === "string" && r.workspaceId.trim() ? r.workspaceId : undefined,
    savedAt: (r.savedAt as string) ?? "",
    app: (r.app as string) ?? "GateLab",
    samples: [
      {
        fileName: s1.fileName ?? "",
        dataPath: s1.dataPath ?? "data/sample.fcs",
        logicleW: scales.logicleW ?? {},
        compensationOn: comp.on ?? false,
      },
    ],
    activeSample: 0,
    gating: r.gating as WorkspaceFile["gating"],
    scales: { globalScales: scales.globalScales ?? {} },
    display: r.display as WorkspaceFile["display"],
  };
}

/**
 * Read a `.gatelab` file, auto-detecting the encoding: a zip ("PK") is a self-contained bundle
 * (returns each sample's FCS bytes by dataPath); otherwise it's a reference workspace (JSON,
 * `fcsByPath` is null and the caller re-links each sample's data file).
 */
export function readWorkspaceBytes(bytes: Uint8Array): {
  ws: WorkspaceFile;
  fcsByPath: Record<string, Uint8Array> | null;
  storage: WorkspaceStorage;
} {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes);
    } catch {
      throw new Error("Not a valid GateLab workspace (could not read the zip).");
    }
    const raw = files["workspace.json"];
    if (!raw) throw new Error("Not a GateLab workspace: workspace.json is missing.");
    const ws = migrateWorkspaceToV2(parseJson(strFromU8(raw)));
    validateWorkspace(ws);
    const fcsByPath: Record<string, Uint8Array> = {};
    const missing: string[] = [];
    for (const s of ws.samples) {
      if (files[s.dataPath]) fcsByPath[s.dataPath] = files[s.dataPath];
      else missing.push(`${s.fileName} (${s.dataPath})`);
    }
    if (missing.length) {
      throw new Error(`Invalid GateLab workspace: bundled FCS data is missing for ${missing.join(", ")}.`);
    }
    return { ws, fcsByPath, storage: "bundle" };
  }
  const ws = migrateWorkspaceToV2(parseJson(strFromU8(bytes)));
  validateWorkspace(ws);
  return { ws, fcsByPath: null, storage: "reference" };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Not a GateLab workspace (unrecognized / corrupt file).");
  }
}

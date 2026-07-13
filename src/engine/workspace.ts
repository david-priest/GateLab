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

export interface WorkspaceSample {
  fileName: string;
  dataPath: string; // unique in-zip path (e.g. "data/0_run.fcs"); also the bundle lookup key
  logicleW: Record<string, number>; // per-sample user W overrides
  compensationOn: boolean; // per-sample
  instrumentMode?: "auto" | "flow" | "cytof"; // per-sample instrument override ('auto' = detected)
  labels?: Record<string, string>; // Panel-tab channel display names, keyed by identity key
  metadata?: Record<string, string>; // per-sample metadata fields (Metadata tab)
  division?: { channelKey: string; boundaries: number[]; n: number; colName: string }; // Division profile
}

export interface WorkspaceFile {
  format: typeof WORKSPACE_FORMAT;
  version: 2;
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
  fontTick: number;
  fontAxis: number;
  fontTitle: number;
  fontGate: number;
}

export interface IllustrationPreset {
  name: string;
  config: IllustrationConfig;
}

/** Pack workspace JSON + each sample's FCS bytes (keyed by dataPath) into a bundled .gatelab zip. */
export function packWorkspace(
  ws: WorkspaceFile,
  fcsByPath: Record<string, Uint8Array>,
  gatingMLXml?: string,
): Uint8Array {
  const files: Record<string, Uint8Array> = { "workspace.json": strToU8(JSON.stringify(ws, null, 2)) };
  for (const [path, bytes] of Object.entries(fcsByPath)) files[path] = bytes;
  if (gatingMLXml) files["gates.gatingml.xml"] = strToU8(gatingMLXml);
  return zipSync(files, { level: 6 });
}

/** A lightweight reference workspace — JSON only; the FCS files are re-linked from disk on open. */
export function packWorkspaceReference(ws: WorkspaceFile): Uint8Array {
  return strToU8(JSON.stringify(ws, null, 2));
}

/** Migrate a parsed workspace to the current (v2, multi-sample) shape. */
function migrate(raw: unknown): WorkspaceFile {
  const r = raw as Record<string, unknown>;
  if (r?.format !== WORKSPACE_FORMAT) throw new Error("Unrecognized workspace format.");
  if (Array.isArray(r.samples)) return raw as WorkspaceFile; // already v2
  // v1 (single sample) → v2
  const s1 = (r.sample ?? {}) as { fileName?: string; dataPath?: string };
  const scales = (r.scales ?? {}) as { logicleW?: Record<string, number>; globalScales?: Record<string, [number, number]> };
  const comp = (r.compensation ?? {}) as { on?: boolean };
  return {
    format: WORKSPACE_FORMAT,
    version: 2,
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
    const ws = migrate(parseJson(strFromU8(raw)));
    const fcsByPath: Record<string, Uint8Array> = {};
    for (const s of ws.samples) if (files[s.dataPath]) fcsByPath[s.dataPath] = files[s.dataPath];
    return { ws, fcsByPath };
  }
  const ws = migrate(parseJson(strFromU8(bytes)));
  return { ws, fcsByPath: null };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Not a GateLab workspace (unrecognized / corrupt file).");
  }
}

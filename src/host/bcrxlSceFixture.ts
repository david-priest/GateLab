// bcrxlSceFixture.ts — test-only: three public Bodenmiller BCR-XL CyTOF files served as one
// SingleCellExperiment by a fake R host, with the public example workspace's gate tree as the
// workspace that SCE carries. Nothing in the app imports this.
//
// The files and the tree are the public, screenshot-safe benchmark in the testing library (see
// src/testFixtures.ts). Each file is parsed here and only its eight marker channels are served,
// channel-major float32, the way GateLabR sends an SCE assay.

import { existsSync, readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import { parseFcs } from "../engine/fcs";
import type { Gate, PopulationMap } from "../engine/models";
import { FIXTURES_ROOT } from "../testFixtures";
import { GATELAB_HOST_CONTRACT_VERSION, type GateLabHostAdapter } from "./contracts";
import { GATELAB_DATASET_CONTRACT_VERSION, type GateLabHostDatasetDescriptor } from "./datasetContract";
import type { GateLabHostPopulationColumn } from "./colDataContract";
import type { GateLabHostWorkspaceMemberships, GateLabHostWorkspaceSource } from "./workspaceContract";

export const BCRXL_DIR = `${FIXTURES_ROOT}/PUBLIC - Screenshot Safe/Bodenmiller BCR-XL CyTOF benchmark`;
export const BCRXL_FILES = [
  "PBMC8_30min_patient1_Reference",
  "PBMC8_30min_patient1_BCR-XL",
  "PBMC8_30min_patient4_Reference",
] as const;
export const BCRXL_MARKERS = ["CD3", "CD20", "CD7", "HLA-DR", "CD123", "IgM", "pS6", "CD4"] as const;
const BUNDLE = `${BCRXL_DIR}/workspaces/Bodenmiller-BCR-XL-complete-16-sample-benchmark.gatelab`;
export const BCRXL_GATINGML = `${BCRXL_DIR}/gatingml/Bodenmiller-BCR-XL-standard.gatingml.xml`;

export const fcsPath = (name: string) => `${BCRXL_DIR}/source-fcs/${name}.fcs`;

/** Whether the public corpus is on this machine (a clean runner does not carry it). */
export function bcrxlAvailable(): boolean {
  return existsSync(BUNDLE) && BCRXL_FILES.every((name) => existsSync(fcsPath(name)));
}

export interface BcrxlTree {
  gates: Record<string, Gate>;
  gate_order: string[];
  populations: PopulationMap;
  root_population_id: string;
}

/** The public example's gate tree, as its bundled workspace.json holds it. */
export function bcrxlTree(): BcrxlTree {
  const files = unzipSync(new Uint8Array(readFileSync(BUNDLE)), { filter: (file) => file.name === "workspace.json" });
  const workspace = JSON.parse(strFromU8(files["workspace.json"]));
  const { gates, gate_order, populations, root_population_id } = workspace.gating;
  return structuredClone({ gates, gate_order, populations, root_population_id });
}

/** The tree as a GateLabR (pre-React) workspace, the form an SCE saved by older GateLabR carries. */
export function bcrxlLegacyWorkspace(tree: BcrxlTree = bcrxlTree()): string {
  return JSON.stringify({ ...tree, gate_value_space: "display", global_scale_ranges: {} });
}

export interface BcrxlSce {
  dataset: GateLabHostDatasetDescriptor;
  names: readonly string[];
  eventCounts: number[];
  assay(sampleId: string): ArrayBuffer;
  eventIndex(sampleId: string): ArrayBuffer;
}

/** The three files as one SCE: sample i is `sample-i`, its events at a running offset. */
export function bcrxlSce(): BcrxlSce {
  const parsed = BCRXL_FILES.map((name) => {
    const bytes = readFileSync(fcsPath(name));
    const fcs = parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const columns = BCRXL_MARKERS.map((marker) => {
      const hits = fcs.channels.filter((channel) => (channel.marker ?? "").split("(")[0].trim() === marker);
      if (hits.length !== 1) throw new Error(`${name}: ${hits.length} channels carry ${marker}`);
      return hits[0];
    });
    const assay = new Float32Array(columns.length * fcs.nEvents);
    columns.forEach((channel, j) => assay.set(fcs.columns[channel.index], j * fcs.nEvents));
    return { name, nEvents: fcs.nEvents, pnn: columns.map((channel) => channel.name), assay };
  });
  const offsets = parsed.map((_, i) => parsed.slice(0, i).reduce((sum, file) => sum + file.nEvents, 0));
  const indexOf = (sampleId: string) => Number(sampleId.split("-")[1]);
  const dataset: GateLabHostDatasetDescriptor = {
    contractVersion: GATELAB_DATASET_CONTRACT_VERSION,
    id: "bcrxl",
    label: "BCR-XL public",
    instrument: "cytof",
    eventCount: parsed.reduce((sum, file) => sum + file.nEvents, 0),
    channels: BCRXL_MARKERS.map((marker, j) => ({ id: marker, label: marker, pnn: parsed[0].pnn[j], pns: marker })),
    assays: [{
      id: "counts", label: "counts", role: "counts", coordinateSpace: "linear", revision: 0,
      encoding: "channel-major-float32-le",
    }],
    defaultAssayId: "counts",
    samples: parsed.map((file, i) => ({
      id: `sample-${i}`, label: file.name, eventCount: file.nEvents, metadata: {},
      assayByteLength: 4 * file.nEvents * BCRXL_MARKERS.length,
      eventIndexEncoding: "uint32-le" as const, eventIndexByteLength: 4 * file.nEvents,
    })),
  };
  return {
    dataset,
    names: parsed.map((file) => file.name),
    eventCounts: parsed.map((file) => file.nEvents),
    assay: (sampleId) => parsed[indexOf(sampleId)].assay.slice().buffer as ArrayBuffer,
    eventIndex: (sampleId) => {
      const i = indexOf(sampleId);
      return Uint32Array.from({ length: parsed[i].nEvents }, (_, k) => offsets[i] + k).buffer as ArrayBuffer;
    },
  };
}

export interface BcrxlHostRecord {
  writes: Array<{ reason: string; workspaceJson: string; memberships?: GateLabHostWorkspaceMemberships }>;
  columnWrites: GateLabHostPopulationColumn[][];
}

/** A fake R host serving `sce`, whose stored workspace is `workspace` (the legacy tree by default). */
export function bcrxlHost(
  sce: BcrxlSce,
  workspace: { sourceFormat: GateLabHostWorkspaceSource; workspaceJson: string } =
    { sourceFormat: "gatelabr-legacy", workspaceJson: bcrxlLegacyWorkspace() },
): { host: GateLabHostAdapter; record: BcrxlHostRecord } {
  const record: BcrxlHostRecord = { writes: [], columnWrites: [] };
  const host: GateLabHostAdapter = {
    contractVersion: GATELAB_HOST_CONTRACT_VERSION,
    id: "bcrxl-test-host",
    kind: "r-sce",
    label: "BCR-XL test host",
    capabilities: {
      dataSources: { fcsFiles: false, singleCellExperiment: true },
      dataModel: { multipleAssays: true, sampleMetadata: true, writeBackColumns: true },
      persistence: { workspaceFiles: false, hostObject: true, fileSystemAccess: false, directoryAccess: false },
      compute: { location: "host" },
    },
    datasets: {
      async listDatasets() { return [sce.dataset]; },
      async readAssay(_datasetId, sampleId) { return sce.assay(sampleId); },
      async readEventIndex(_datasetId, sampleId) { return sce.eventIndex(sampleId); },
    },
    workspaces: {
      async readWorkspace() {
        return {
          contractVersion: 1,
          datasetId: sce.dataset.id,
          sourceFormat: workspace.sourceFormat,
          revision: workspace.sourceFormat === "gatelabr-legacy" ? 0 : 1,
          workspaceJson: workspace.workspaceJson,
        };
      },
      async writeWorkspace(request) {
        record.writes.push({ reason: request.reason, workspaceJson: request.workspaceJson, memberships: request.memberships });
        return {
          revision: request.expectedRevision + 1,
          clientRevision: request.clientRevision,
          savedAt: "2026-09-24T00:00:00Z",
          // As GateLabR reports the memberships it stored.
          ...(request.memberships ? {
            memberships: { hierarchies: request.memberships.hierarchies.length, populations: request.memberships.populations.length },
          } : {}),
        };
      },
    },
    colData: {
      async writeColumns(request) {
        record.columnWrites.push([...request.columns]);
        return { columns: request.columns.map(({ columnName, populationId }) => ({ columnName, populationId, memberCount: 0 })) };
      },
      async writeCategoricalColumns() { throw new Error("not under test"); },
    },
  };
  return { host, record };
}

/** Unpack one sample's LSB-first membership bits. */
export function membershipBits(base64: string, count: number): number[] {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return Array.from({ length: count }, (_, i) => (bytes[i >> 3] >> (i & 7)) & 1);
}

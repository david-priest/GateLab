// A bundle's stored compensated assays: written beside the assay in use, located on opening and
// read only when installed, checked by SHA-256, set aside where they cannot be relied on, and
// skipped by a reader that does not know them. Synthetic four-event file; no real data.

import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import { Sample } from "./sample";
import type { Sha256Digest } from "./compensationProfile";
import { compensatedBindingSignature, digestBytesSha256 } from "./compensationCache";
import { columnsForGate, getGateMask } from "./gates";
import type { Gate } from "./models";
import type { PersistedCompensatedLayerBinding } from "./workspaceCompensation";
import { SAMPLE_ASSAY_BINDING_SCHEMA, WORKSPACE_COMPENSATION_SCHEMA } from "./workspaceCompensation";
import { WORKSPACE_FORMAT, readWorkspaceEnvelopeFromFile } from "./workspace";
import {
  createPortableWorkspaceV3ArchivePlan,
  writePortableWorkspaceV3Archive,
  WORKSPACE_VERSION_3,
  type WorkspaceFileV3,
} from "./workspaceV3";
import { PORTABLE_ASSAY_MANIFEST_PATH, restorePortableAssayLayers } from "./workspacePortableAssays";
import { readZipFileEntries, writeStoredZip } from "./workspaceArchiveStream";
import {
  float32ColumnBytes,
  readStoredAssayColumn,
  STORED_ASSAY_MANIFEST_PATH,
  type StoredAssayLayerSource,
} from "./workspaceStoredAssays";

const digest = (character: string): Sha256Digest => `sha256:${character.repeat(64)}` as Sha256Digest;

function fcs(): FcsFile {
  return {
    version: "FCS3.1",
    nEvents: 4,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262_144 },
      { index: 1, name: "FL1-A", marker: "CD3", bits: 32, range: 262_144 },
      { index: 2, name: "FL2-A", marker: "CD19", bits: 32, range: 262_144 },
    ],
    columns: [
      Float32Array.from([100, 200, 300, 400]),
      Float32Array.from([10, 20, 30, 40]),
      Float32Array.from([1, 2, 3, 4]),
    ],
    spillover: null,
  };
}

function binding(profileId: string, profileHash: Sha256Digest, matrixHash: Sha256Digest): PersistedCompensatedLayerBinding {
  return {
    profileId,
    profileHash,
    matrixHash,
    kind: "flow-spillover",
    method: "matrix-inverse",
    includedPnns: ["FL1-A", "FL2-A"],
    channelBindings: [
      { pnn: "FL1-A", fcsColumnIndex: 1, matrixSourceIndex: 0, matrixReceiverIndex: 0, included: true },
      { pnn: "FL2-A", fcsColumnIndex: 2, matrixSourceIndex: 1, matrixReceiverIndex: 1, included: true },
    ],
    transformBinding: { kind: "flow-linear" },
  };
}

/** The matrix in use (saved under `assays/`) and a second one applied before it (stored). */
const IN_USE = binding("profile-in-use", digest("a"), digest("b"));
const EARLIER = binding("profile-earlier", digest("c"), digest("d"));
const IN_USE_VALUES = [Float32Array.from([9, 18, 27, 36]), Float32Array.from([-1, -2, -3, -4])];
const EARLIER_VALUES = [Float32Array.from([5, 15, 25, 35]), Float32Array.from([2, 4, 6, 8])];
const DATA_PATH = "data/0_sample.fcs";
const FCS_BYTES = new TextEncoder().encode("exact source FCS bytes");

function workspace(): WorkspaceFileV3 {
  return {
    format: WORKSPACE_FORMAT,
    version: WORKSPACE_VERSION_3,
    workspaceId: "stored-assays-test",
    savedAt: "2026-11-20T00:00:00.000Z",
    app: "GateLab test",
    samples: [{
      fileName: "sample.fcs",
      dataPath: DATA_PATH,
      logicleW: {},
      assay: { schema: SAMPLE_ASSAY_BINDING_SCHEMA, activeLayer: "compensated", compensatedLayer: IN_USE },
    }],
    activeSample: 0,
    gating: {
      gates: {},
      gate_order: [],
      populations: {
        root: {
          population_id: "root", name: "All Events", parent_id: null, children: [], gate_refs: [],
          gate_logic: "and", event_count: 4, percent_of_parent: 100,
        },
      },
      root_population_id: "root",
      active_population_id: "root",
      selected_gate_id: null,
    },
    scales: { globalScales: {} },
    display: { xChannel: "FL1-A", yChannel: "FL2-A", mode: "pseudocolor", maxEvents: 50_000, contourThreshold: 5 },
    compensation: { schema: WORKSPACE_COMPENSATION_SCHEMA, lineages: [] },
  };
}

function sampleInUse(): Sample {
  const sample = new Sample(fcs());
  sample.installCompensatedLayer({
    metadata: IN_USE,
    columns: [
      { pnn: "FL1-A", fcsColumnIndex: 1, values: IN_USE_VALUES[0] },
      { pnn: "FL2-A", fcsColumnIndex: 2, values: IN_USE_VALUES[1] },
    ],
  }, { activeLayer: "compensated" });
  return sample;
}

async function storedLayer(reads: { count: number } = { count: 0 }): Promise<StoredAssayLayerSource> {
  return {
    dataPath: DATA_PATH,
    fcsDigest: await digestBytesSha256(FCS_BYTES),
    eventCount: 4,
    profileId: EARLIER.profileId,
    profileHash: EARLIER.profileHash,
    matrixHash: EARLIER.matrixHash,
    bindingSignature: compensatedBindingSignature(EARLIER),
    columns: await Promise.all(EARLIER_VALUES.map(async (values, index) => ({
      pnn: index === 0 ? "FL1-A" : "FL2-A",
      fcsColumnIndex: index + 1,
      byteLength: values.byteLength,
      digest: await digestBytesSha256(float32ColumnBytes(values)),
      read: async () => {
        reads.count++;
        return float32ColumnBytes(values).slice();
      },
    }))),
  };
}

async function bundle(layers: StoredAssayLayerSource[]): Promise<Uint8Array> {
  const plan = await createPortableWorkspaceV3ArchivePlan(
    workspace(),
    [{ dataPath: DATA_PATH, fcsBytes: FCS_BYTES, sample: sampleInUse() }],
    undefined,
    {},
    layers,
  );
  const chunks: Uint8Array[] = [];
  await writePortableWorkspaceV3Archive(plan, async (chunk) => { chunks.push(chunk); }, { chunkBytes: 5 });
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const asFile = (bytes: Uint8Array) => new File([bytes.slice().buffer as ArrayBuffer], "stored.gatelab", { type: "application/zip" });

/** A raw-space rectangle on the compensated FL1-A / FL2-A plane: holds events 2 and 3 under the earlier matrix only. */
const counted = (sample: Sample) => {
  const gate = {
    gate_id: "g", name: "G", gate_type: "rectangle", space: "raw",
    x_channel: sample.channels[1].key, y_channel: sample.channels[2].key,
    vertices: [[10, 3], [30, 3], [30, 7], [10, 7]], color: "#000", label_offset: null,
  } as unknown as Gate;
  return getGateMask(gate, columnsForGate(sample.gateAssayData(), gate)).reduce((a, b) => a + b, 0);
};

describe("a bundle's stored compensated assays", () => {
  it("are written beside the assay in use and read back exactly, one column at a time, when installed", async () => {
    const reads = { count: 0 };
    const file = asFile(await bundle([await storedLayer(reads)]));
    expect(reads.count).toBe(2);
    const envelope = await readWorkspaceEnvelopeFromFile(file);
    expect(envelope.storedAssaysProblem).toBeUndefined();
    const stored = envelope.storedAssays!;
    expect(stored.manifest.layers).toHaveLength(1);
    const [layer] = stored.manifest.layers;
    expect(layer).toMatchObject({
      dataPath: DATA_PATH,
      fcsDigest: await digestBytesSha256(FCS_BYTES),
      profileId: "profile-earlier",
      bindingSignature: compensatedBindingSignature(EARLIER),
    });

    // The assay in use restores as before.
    const sample = new Sample(fcs());
    await restorePortableAssayLayers(envelope.portableAssays!, workspace(), [{ dataPath: DATA_PATH, fcsBytes: FCS_BYTES, sample }]);
    expect(sample.compensatedLayerStatus(IN_USE).state).toBe("ready");
    expect(counted(sample)).toBe(0);

    // The stored layer, read and installed, is the earlier matrix's values to the bit, and the gate
    // drawn on the compensated plane counts the events those values put in it.
    const columns = await Promise.all(layer.columns.map(async (column) => ({
      pnn: column.pnn,
      fcsColumnIndex: column.fcsColumnIndex,
      values: await readStoredAssayColumn(stored, column, layer.eventCount),
    })));
    expect(columns.map(({ values }) => Array.from(values))).toEqual(EARLIER_VALUES.map((values) => Array.from(values)));
    sample.installCompensatedLayer({ metadata: EARLIER, columns }, { activeLayer: "compensated" });
    expect(sample.compensatedLayerStatus(EARLIER).state).toBe("ready");
    expect(counted(sample)).toBe(2);
  });

  it("are skipped by a reader that selects only the bundle's own entries, which then opens it as before", async () => {
    const file = asFile(await bundle([await storedLayer()]));
    // The selection of a GateLab without this section (workspace.ts before it).
    const files = await readZipFileEntries(file, {
      select: (path) => path === "workspace.json" || path === PORTABLE_ASSAY_MANIFEST_PATH ||
        path.startsWith("data/") || (path.startsWith("assays/") && path.endsWith(".f32")),
    });
    expect(Object.keys(files).some((path) => path.startsWith("stored-assays/"))).toBe(false);
    const envelope = await readWorkspaceEnvelopeFromFile(file);
    const sample = new Sample(fcs());
    await expect(restorePortableAssayLayers(envelope.portableAssays!, workspace(), [{ dataPath: DATA_PATH, fcsBytes: FCS_BYTES, sample }]))
      .resolves.toMatchObject({ sampleCount: 1 });
  });

  it("write no section where none is stored", async () => {
    const envelope = await readWorkspaceEnvelopeFromFile(asFile(await bundle([])));
    expect(envelope.storedAssays).toBeUndefined();
  });

  it("refuse a column whose bytes no longer match its SHA-256", async () => {
    const bytes = await bundle([await storedLayer()]);
    const envelope = await readWorkspaceEnvelopeFromFile(asFile(bytes));
    const column = envelope.storedAssays!.manifest.layers[0].columns[0];
    const location = envelope.storedAssays!.locations.get(column.path)!;
    const damaged = bytes.slice();
    damaged[location.dataStart] ^= 0xff;
    const reopened = await readWorkspaceEnvelopeFromFile(asFile(damaged));
    await expect(readStoredAssayColumn(reopened.storedAssays!, column, 4)).rejects.toThrow(/SHA-256/);
  });

  it("are set aside, and the workspace opens, where the section declares a file it lacks or holds one it does not declare", async () => {
    const bytes = await bundle([await storedLayer()]);
    const files = await readZipFileEntries(asFile(bytes), { select: () => true });
    const rewrite = async (entries: Record<string, Uint8Array>) => {
      const chunks: Uint8Array[] = [];
      await writeStoredZip(Object.entries(entries).map(([path, payload]) => ({ path, bytes: payload })), async (chunk) => { chunks.push(chunk); });
      const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
      return asFile(out);
    };
    const { ["stored-assays/0/1.f32"]: _dropped, ...missing } = files;
    const withoutColumn = await readWorkspaceEnvelopeFromFile(await rewrite(missing));
    expect(withoutColumn.storedAssays).toBeNull();
    expect(withoutColumn.storedAssaysProblem).toMatch(/missing/);
    expect(withoutColumn.portableAssays).not.toBeNull();

    const extra = await readWorkspaceEnvelopeFromFile(await rewrite({ ...files, "stored-assays/9/0.f32": new Uint8Array(16) }));
    expect(extra.storedAssays).toBeNull();
    expect(extra.storedAssaysProblem).toMatch(/not declared/);
    expect(files[STORED_ASSAY_MANIFEST_PATH]).toBeDefined();
  });

  it("refuse to write a column whose bytes changed after the plan was made", async () => {
    const layer = await storedLayer();
    const changed: StoredAssayLayerSource = {
      ...layer,
      columns: layer.columns.map((column, index) => index === 0
        ? { ...column, read: async () => float32ColumnBytes(Float32Array.from([0, 0, 0, 0])) }
        : column),
    };
    await expect(bundle([changed])).rejects.toThrow(/changed after the save began/);
  });

  it("refuse a layer for a file the workspace does not hold, or one stored twice", async () => {
    const layer = await storedLayer();
    await expect(bundle([{ ...layer, dataPath: "data/9_other.fcs" }])).rejects.toThrow(/not a file of this workspace/);
    await expect(bundle([layer, layer])).rejects.toThrow(/repeats an earlier layer/);
  });
});

// The session's stored compensated layers: kept by reference while in use, moved to disk when
// replaced, read back exactly, written to and read from a bundle, and let go with their matrix.
// Synthetic four-event file; no real data.

import { describe, expect, it } from "vitest";
import { compensatedBindingSignature, digestBytesSha256 } from "../engine/compensationCache";
import type { Sha256Digest } from "../engine/compensationProfile";
import type { FcsFile } from "../engine/fcs";
import { Sample } from "../engine/sample";
import type { PersistedCompensatedLayerBinding } from "../engine/workspaceCompensation";
import { writeStoredZip } from "../engine/workspaceArchiveStream";
import { createStoredAssayArchivePlan, locateStoredAssays, STORED_ASSAY_MANIFEST_PATH } from "../engine/workspaceStoredAssays";
import { StoredAssayStore, storedLayerKey, type StoredColumnDisk } from "./storedAssayStore";

const digest = (character: string): Sha256Digest => `sha256:${character.repeat(64)}` as Sha256Digest;
const FCS_DIGEST = digest("f");

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
    columns: [Float32Array.from([1, 2, 3, 4]), Float32Array.from([10, 20, 30, 40]), Float32Array.from([1, 2, 3, 4])],
    spillover: null,
  };
}

function binding(profileId: string, hash: string): PersistedCompensatedLayerBinding {
  return {
    profileId,
    profileHash: digest(hash),
    matrixHash: digest(hash === "a" ? "b" : "d"),
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

const M1 = binding("m1", "a");
const M2 = binding("m2", "c");
const VALUES = {
  m1: [Float32Array.from([9, 18, 27, 36]), Float32Array.from([-1, -2, -3, -4])],
  m2: [Float32Array.from([5, 15, 25, 35]), Float32Array.from([2, 4, 6, 8])],
};

function install(sample: Sample, layer: PersistedCompensatedLayerBinding, values: Float32Array[]): void {
  sample.installCompensatedLayer({
    metadata: layer,
    columns: [
      { pnn: "FL1-A", fcsColumnIndex: 1, values: values[0] },
      { pnn: "FL2-A", fcsColumnIndex: 2, values: values[1] },
    ],
  }, { activeLayer: "compensated" });
}

function memoryDisk() {
  const files = new Map<string, Uint8Array>();
  const disk: StoredColumnDisk = {
    write: async (name, bytes) => { files.set(name, bytes.slice()); },
    read: async (name) => {
      const bytes = files.get(name);
      if (!bytes) throw new Error("missing");
      return bytes.slice();
    },
    remove: async (name) => { files.delete(name); },
  };
  return { files, disk };
}

describe("the stored compensated layers", () => {
  it("keep the layer in use by reference, move it to disk once replaced, and give back its values exactly", async () => {
    const { files, disk } = memoryDisk();
    const store = new StoredAssayStore(disk);
    const sample = new Sample(fcs());
    install(sample, M1, VALUES.m1);
    expect(store.recordInstalled(FCS_DIGEST, sample, M1)).toBe(true);
    const m1Key = storedLayerKey(FCS_DIGEST, compensatedBindingSignature(M1));
    await store.spill(new Set([m1Key]));
    expect(files.size).toBe(0);

    install(sample, M2, VALUES.m2);
    store.recordInstalled(FCS_DIGEST, sample, M2);
    await store.spill(new Set([storedLayerKey(FCS_DIGEST, compensatedBindingSignature(M2))]));
    expect(files.size).toBe(2);

    const m1 = store.find(FCS_DIGEST, compensatedBindingSignature(M1))!;
    expect(m1.columns.every(({ source, digest: d }) => source.kind === "disk" && d !== null)).toBe(true);
    const columns = await store.readColumns(m1);
    expect(columns.map(({ values }) => Array.from(values))).toEqual(VALUES.m1.map((values) => Array.from(values)));
    // Installed again, the file reads the first matrix's values.
    sample.installCompensatedLayer({ metadata: M1, columns }, { activeLayer: "compensated" });
    expect(sample.compensatedColumnData(1, M1)).toEqual(VALUES.m1[0]);
  });

  it("keep a replaced layer in memory where the browser has no disk", async () => {
    const store = new StoredAssayStore();
    const sample = new Sample(fcs());
    install(sample, M1, VALUES.m1);
    store.recordInstalled(FCS_DIGEST, sample, M1);
    install(sample, M2, VALUES.m2);
    await store.spill(new Set());
    const m1 = store.find(FCS_DIGEST, compensatedBindingSignature(M1))!;
    expect(m1.columns[0].source.kind).toBe("memory");
    expect(Array.from((await store.readColumns(m1))[1].values)).toEqual([-1, -2, -3, -4]);
  });

  it("are written as a bundle's stored layers, read back from it, and read from the new file after a save", async () => {
    const { files, disk } = memoryDisk();
    const store = new StoredAssayStore(disk);
    const sample = new Sample(fcs());
    install(sample, M1, VALUES.m1);
    store.recordInstalled(FCS_DIGEST, sample, M1);
    install(sample, M2, VALUES.m2);
    await store.spill(new Set());
    const layer = store.find(FCS_DIGEST, compensatedBindingSignature(M1))!;
    const source = await store.bundleSource(layer, "data/0_sample.fcs");
    expect(source.columns.map(({ digest: d }) => d)).toEqual(await Promise.all(
      VALUES.m1.map((values) => digestBytesSha256(new Uint8Array(values.buffer))),
    ));

    const plan = createStoredAssayArchivePlan([source])!;
    const chunks: Uint8Array[] = [];
    await writeStoredZip(plan.entries, async (chunk) => { chunks.push(chunk); });
    const file = new File(chunks.map((chunk) => chunk.slice().buffer as ArrayBuffer), "saved.gatelab");
    const manifestBytes = new TextEncoder().encode(JSON.stringify(plan.manifest));
    const archive = await locateStoredAssays(file, manifestBytes);

    // A store that opened the bundle reads the layer from it.
    const reopened = new StoredAssayStore();
    expect(reopened.addBundle(archive)).toBe(1);
    const fromBundle = reopened.find(FCS_DIGEST, compensatedBindingSignature(M1))!;
    expect((await reopened.readColumns(fromBundle)).map(({ values }) => Array.from(values)))
      .toEqual(VALUES.m1.map((values) => Array.from(values)));

    // The store that wrote it reads it from the new file and lets its disk copy go.
    await store.rebindToBundle(archive);
    expect(layer.columns.every(({ source: s }) => s.kind === "bundle")).toBe(true);
    expect(files.size).toBe(0);
    expect(plan.entries[0].path).toBe(STORED_ASSAY_MANIFEST_PATH);
  });

  it("let a matrix's layers go when the workspace no longer holds it", async () => {
    const { files, disk } = memoryDisk();
    const store = new StoredAssayStore(disk);
    const sample = new Sample(fcs());
    install(sample, M1, VALUES.m1);
    store.recordInstalled(FCS_DIGEST, sample, M1);
    install(sample, M2, VALUES.m2);
    store.recordInstalled(FCS_DIGEST, sample, M2);
    await store.spill(new Set([storedLayerKey(FCS_DIGEST, compensatedBindingSignature(M2))]));
    expect(files.size).toBe(2);
    await store.retainProfiles(new Set(["m2"]));
    expect(store.find(FCS_DIGEST, compensatedBindingSignature(M1))).toBeUndefined();
    expect(store.find(FCS_DIGEST, compensatedBindingSignature(M2))).toBeDefined();
    expect(files.size).toBe(0);
  });
});

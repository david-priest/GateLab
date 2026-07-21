import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import { Sample } from "./sample";
import type { Sha256Digest } from "./compensationProfile";
import type { PersistedCompensatedLayerBinding } from "./workspaceCompensation";
import { SAMPLE_ASSAY_BINDING_SCHEMA, WORKSPACE_COMPENSATION_SCHEMA } from "./workspaceCompensation";
import {
  WORKSPACE_FORMAT,
  readWorkspaceEnvelope,
  readWorkspaceEnvelopeFromFile,
} from "./workspace";
import {
  createPortableWorkspaceV3ArchivePlan,
  writePortableWorkspaceV3Archive,
  WORKSPACE_VERSION_3,
  type WorkspaceFileV3,
} from "./workspaceV3";
import { restorePortableAssayLayers } from "./workspacePortableAssays";

const digest = (character: string): Sha256Digest =>
  `sha256:${character.repeat(64)}` as Sha256Digest;

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

function binding(): PersistedCompensatedLayerBinding {
  return {
    profileId: "flow-profile",
    profileHash: digest("a"),
    matrixHash: digest("b"),
    kind: "flow-spillover",
    method: "matrix-inverse",
    includedPnns: ["FL1-A", "FL2-A"],
    channelBindings: [
      {
        pnn: "FL1-A",
        fcsColumnIndex: 1,
        matrixSourceIndex: 0,
        matrixReceiverIndex: 0,
        included: true,
      },
      {
        pnn: "FL2-A",
        fcsColumnIndex: 2,
        matrixSourceIndex: 1,
        matrixReceiverIndex: 1,
        included: true,
      },
    ],
    transformBinding: { kind: "flow-linear" },
  };
}

function install(sample: Sample, activeLayer: "original" | "compensated" = "compensated"): void {
  sample.installCompensatedLayer({
    metadata: binding(),
    columns: [
      { pnn: "FL1-A", fcsColumnIndex: 1, values: Float32Array.from([9, 18, 27, 36]) },
      { pnn: "FL2-A", fcsColumnIndex: 2, values: Float32Array.from([-1, -2, -3, -4]) },
    ],
  }, { activeLayer });
}

function workspace(activeLayer: "original" | "compensated" = "compensated"): WorkspaceFileV3 {
  return {
    format: WORKSPACE_FORMAT,
    version: WORKSPACE_VERSION_3,
    workspaceId: "portable-test",
    savedAt: "2026-07-20T00:00:00.000Z",
    app: "GateLab test",
    samples: [{
      fileName: "sample.fcs",
      dataPath: "data/0_sample.fcs",
      logicleW: {},
      assay: {
        schema: SAMPLE_ASSAY_BINDING_SCHEMA,
        activeLayer,
        compensatedLayer: binding(),
      },
    }],
    activeSample: 0,
    gating: {
      gates: {},
      gate_order: [],
      populations: {
        root: {
          population_id: "root",
          name: "All Events",
          parent_id: null,
          children: [],
          gate_refs: [],
          gate_logic: "and",
          event_count: 4,
          percent_of_parent: 100,
        },
      },
      root_population_id: "root",
      active_population_id: "root",
      selected_gate_id: null,
    },
    scales: { globalScales: {} },
    display: {
      xChannel: "FL1-A",
      yChannel: "FL2-A",
      mode: "pseudocolor",
      maxEvents: 50_000,
      contourThreshold: 5,
    },
    compensation: { schema: WORKSPACE_COMPENSATION_SCHEMA, lineages: [] },
  };
}

async function archiveBytes(ws: WorkspaceFileV3, sample: Sample, fcsBytes: Uint8Array): Promise<Uint8Array> {
  return archiveBytesForSources(ws, [{
    dataPath: ws.samples[0].dataPath,
    sample,
    fcsBytes,
  }]);
}

async function archiveBytesForSources(
  ws: WorkspaceFileV3,
  sources: Parameters<typeof createPortableWorkspaceV3ArchivePlan>[1],
): Promise<Uint8Array> {
  const plan = await createPortableWorkspaceV3ArchivePlan(ws, sources);
  const chunks: Uint8Array[] = [];
  await writePortableWorkspaceV3Archive(plan, async (chunk) => {
    chunks.push(chunk);
  }, { chunkBytes: 7 });
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

describe("portable compensated workspace assays", () => {
  it("round-trips exact Float32 columns and preserves the saved active layer", async () => {
    const source = new Sample(fcs());
    install(source, "original");
    const ws = workspace("original");
    const fcsBytes = new TextEncoder().encode("exact source FCS bytes");
    const envelope = readWorkspaceEnvelope(await archiveBytes(ws, source, fcsBytes));
    expect(envelope.portableAssays).not.toBeNull();
    expect(envelope.fcsByPath?.[ws.samples[0].dataPath]).toEqual(fcsBytes);

    const restored = new Sample(fcs());
    const result = await restorePortableAssayLayers(envelope.portableAssays!, ws, [{
      dataPath: ws.samples[0].dataPath,
      fcsBytes,
      sample: restored,
    }]);

    expect(result).toMatchObject({ sampleCount: 1, eventCount: 4 });
    expect(restored.activeLayer).toBe("original");
    expect(restored.compensatedLayerStatus(binding()).state).toBe("ready");
    expect(restored.compensatedColumnData(1, binding())).toEqual(
      Float32Array.from([9, 18, 27, 36]),
    );
    expect(restored.compensatedColumnData(2, binding())).toEqual(
      Float32Array.from([-1, -2, -3, -4]),
    );
  });

  it("streams the same portable envelope from a File without reading one archive buffer", async () => {
    const source = new Sample(fcs());
    install(source);
    const ws = workspace();
    const fcsBytes = new TextEncoder().encode("streamed source FCS bytes");
    const bytes = await archiveBytes(ws, source, fcsBytes);

    const envelope = await readWorkspaceEnvelopeFromFile(
      new File([bytes.slice().buffer as ArrayBuffer], "portable.gatelab", { type: "application/zip" }),
    );

    expect(envelope.storage).toBe("bundle");
    expect(envelope.raw).toEqual(ws);
    expect(envelope.fcsByPath?.[ws.samples[0].dataPath]).toEqual(fcsBytes);
    expect(envelope.portableAssays?.manifest.samples[0].assay?.columns).toHaveLength(2);
  });

  it("fails closed and leaves Sample untouched when a derived byte is corrupted", async () => {
    const source = new Sample(fcs());
    install(source);
    const ws = workspace();
    const fcsBytes = new TextEncoder().encode("exact source FCS bytes");
    const envelope = readWorkspaceEnvelope(await archiveBytes(ws, source, fcsBytes));
    const path = envelope.portableAssays!.manifest.samples[0].assay!.columns[0].path;
    const corrupt = Object.fromEntries(Object.entries(envelope.portableAssays!.files).map(
      ([name, bytes]) => [name, bytes.slice()],
    ));
    corrupt[path][0] ^= 0xff;
    const restored = new Sample(fcs());

    await expect(restorePortableAssayLayers(
      { manifest: envelope.portableAssays!.manifest, files: corrupt },
      ws,
      [{ dataPath: ws.samples[0].dataPath, fcsBytes, sample: restored }],
    )).rejects.toMatchObject({ code: "corrupt-column" });
    expect(restored.compensatedLayerStatus().state).toBe("missing");
    expect(restored.activeLayer).toBe("original");
    expect(restored.dataRevision).toBe(0);
    expect(restored.layerRevision).toBe(0);
  });

  it("rejects a same-sized but different source FCS before installing anything", async () => {
    const source = new Sample(fcs());
    install(source);
    const ws = workspace();
    const fcsBytes = new TextEncoder().encode("source-A");
    const envelope = readWorkspaceEnvelope(await archiveBytes(ws, source, fcsBytes));
    const restored = new Sample(fcs());

    await expect(restorePortableAssayLayers(
      envelope.portableAssays!,
      ws,
      [{
        dataPath: ws.samples[0].dataPath,
        fcsBytes: new TextEncoder().encode("source-B"),
        sample: restored,
      }],
    )).rejects.toMatchObject({ code: "source-mismatch" });
    expect(restored.compensatedLayerStatus().state).toBe("missing");
  });

  it("validates every sample before an atomic multi-sample install", async () => {
    const firstSource = new Sample(fcs());
    const secondSource = new Sample(fcs());
    install(firstSource);
    install(secondSource);
    const base = workspace();
    const ws: WorkspaceFileV3 = {
      ...base,
      samples: [
        { ...base.samples[0], fileName: "sample-a.fcs", dataPath: "data/0_sample-a.fcs" },
        { ...base.samples[0], fileName: "sample-b.fcs", dataPath: "data/1_sample-b.fcs" },
      ],
    };
    const firstBytes = new TextEncoder().encode("source FCS A");
    const secondBytes = new TextEncoder().encode("source FCS B");
    const envelope = readWorkspaceEnvelope(await archiveBytesForSources(ws, [
      { dataPath: ws.samples[0].dataPath, fcsBytes: firstBytes, sample: firstSource },
      { dataPath: ws.samples[1].dataPath, fcsBytes: secondBytes, sample: secondSource },
    ]));
    const corruptFiles = Object.fromEntries(Object.entries(envelope.portableAssays!.files).map(
      ([name, bytes]) => [name, bytes.slice()],
    ));
    const corruptPath = envelope.portableAssays!.manifest.samples[1].assay!.columns[1].path;
    corruptFiles[corruptPath][corruptFiles[corruptPath].length - 1] ^= 0xff;
    const firstRestored = new Sample(fcs());
    const secondRestored = new Sample(fcs());

    await expect(restorePortableAssayLayers(
      { manifest: envelope.portableAssays!.manifest, files: corruptFiles },
      ws,
      [
        { dataPath: ws.samples[0].dataPath, fcsBytes: firstBytes, sample: firstRestored },
        { dataPath: ws.samples[1].dataPath, fcsBytes: secondBytes, sample: secondRestored },
      ],
    )).rejects.toMatchObject({ code: "corrupt-column" });
    for (const sample of [firstRestored, secondRestored]) {
      expect(sample.compensatedLayerStatus().state).toBe("missing");
      expect([sample.dataRevision, sample.layerRevision]).toEqual([0, 0]);
    }
  });

  it("cancels after validation without exposing a partially restored assay", async () => {
    const source = new Sample(fcs());
    install(source);
    const ws = workspace();
    const fcsBytes = new TextEncoder().encode("cancellable source FCS");
    const envelope = readWorkspaceEnvelope(await archiveBytes(ws, source, fcsBytes));
    const restored = new Sample(fcs());
    let cancelled = false;

    await expect(restorePortableAssayLayers(
      envelope.portableAssays!,
      ws,
      [{ dataPath: ws.samples[0].dataPath, fcsBytes, sample: restored }],
      {
        onProgress: ({ processedBytes, totalBytes }) => {
          if (processedBytes === totalBytes) cancelled = true;
        },
        checkCancelled: () => {
          if (cancelled) throw new Error("test restore cancellation");
        },
      },
    )).rejects.toThrow("test restore cancellation");
    expect(restored.compensatedLayerStatus().state).toBe("missing");
    expect([restored.dataRevision, restored.layerRevision]).toEqual([0, 0]);
  });
});

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { GateLabHostProvider } from "./host/HostContext";
import {
  GATELAB_DATASET_CONTRACT_VERSION,
  type GateLabHostDatasetDescriptor,
} from "./host/datasetContract";
import {
  GATELAB_HOST_CONTRACT_VERSION,
  type GateLabHostAdapter,
} from "./host/contracts";
import { GateLabWorkspaceConflictError } from "./host/workspaceContract";
import { decodeFloat32Base64 } from "./engine/encode";

const plotHarness = vi.hoisted(() => ({
  eventCount: null as number | null,
  payload: null as {
    gates?: Array<{ gate_id: string; vertices: [number, number][] }>;
    n_events: number;
  } | null,
  onNewGate: null as ((gate: {
    gate_type: "rectangle" | "polygon" | "quadrant";
    vertices: [number, number][];
    x_channel: string;
    y_channel: string;
  }) => void) | null,
  onGateEdit: null as ((edit: {
    gate_id: string;
    vertices: [number, number][];
  }) => void) | null,
}));

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: ({
    payload,
    onNewGate,
    onGateEdit,
  }: {
    payload: {
      gates?: Array<{ gate_id: string; vertices: [number, number][] }>;
      n_events: number;
    };
    onNewGate?: NonNullable<typeof plotHarness.onNewGate>;
    onGateEdit?: NonNullable<typeof plotHarness.onGateEdit>;
  }) => {
    plotHarness.eventCount = payload.n_events;
    plotHarness.payload = payload;
    plotHarness.onNewGate = onNewGate ?? null;
    plotHarness.onGateEdit = onGateEdit ?? null;
    return <div data-testid="gating-plot" />;
  },
}));

function bufferOf(values: Float32Array | Uint32Array): ArrayBuffer {
  return values.buffer.slice(
    values.byteOffset,
    values.byteOffset + values.byteLength,
  ) as ArrayBuffer;
}

const dataset: GateLabHostDatasetDescriptor = {
  contractVersion: GATELAB_DATASET_CONTRACT_VERSION,
  id: "sce",
  label: "Hosted SCE",
  instrument: "cytof",
  eventCount: 3,
  channels: [
    { id: "CD3", label: "CD3", pnn: "Nd142Di", pns: "CD3" },
    { id: "CD19", label: "CD19", pnn: "Eu151Di", pns: "CD19" },
  ],
  assays: [{
    id: "counts",
    label: "counts",
    role: "counts",
    coordinateSpace: "linear",
    revision: 0,
    encoding: "channel-major-float32-le",
  }],
  defaultAssayId: "counts",
  samples: [
    {
      id: "sample-0",
      label: "Donor A",
      eventCount: 2,
      metadata: { batch: "one" },
      assayByteLength: 16,
      eventIndexEncoding: "uint32-le",
      eventIndexByteLength: 8,
    },
    {
      id: "sample-1",
      label: "Donor B",
      eventCount: 1,
      metadata: { batch: "two" },
      assayByteLength: 8,
      eventIndexEncoding: "uint32-le",
      eventIndexByteLength: 4,
    },
  ],
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", {
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
  });
  plotHarness.eventCount = null;
  plotHarness.payload = null;
  plotHarness.onNewGate = null;
  plotHarness.onGateEdit = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("App SCE host loading", () => {
  it("loads every SCE sample into the ordinary GateLab sample navigator and plot", async () => {
    const readAssay = vi.fn(async (
      _datasetId: string,
      sampleId: string,
      assayId: string,
    ) => {
      expect(assayId).toBe("counts");
      return sampleId === "sample-0"
        ? bufferOf(new Float32Array([5, 10, 20, 25]))
        : bufferOf(new Float32Array([15, 30]));
    });
    const host: GateLabHostAdapter = {
      contractVersion: GATELAB_HOST_CONTRACT_VERSION,
      id: "test-r-host",
      kind: "r-sce",
      label: "Test R host",
      build: { hostVersion: "1.6.0", hostCommit: "0123456789abcdef0123456789abcdef01234567", coreCommit: "89abcdef0123456789abcdef0123456789abcdef" },
      capabilities: {
        dataSources: { fcsFiles: false, singleCellExperiment: true },
        dataModel: {
          multipleAssays: true,
          sampleMetadata: true,
          writeBackColumns: true,
        },
        persistence: {
          workspaceFiles: false,
          hostObject: true,
          fileSystemAccess: false,
          directoryAccess: false,
        },
        compute: { location: "host" },
      },
      datasets: {
        async listDatasets() {
          return [dataset];
        },
        readAssay,
        async readEventIndex(_datasetId, sampleId) {
          return sampleId === "sample-0"
            ? bufferOf(new Uint32Array([0, 2]))
            : bufferOf(new Uint32Array([1]));
        },
      },
    };

    await act(async () => {
      root.render(
        <GateLabHostProvider host={host}>
          <App />
        </GateLabHostProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(readAssay).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Donor A");
    expect(container.textContent).toContain("Donor B");
    expect(container.textContent).toContain("Loaded Hosted SCE · 2 samples · 3 events from R");
    expect(container.textContent).toContain("GateLabR");
    expect(container.textContent).toContain("SingleCellExperiment · workspace revision 0 · unsaved");
    expect(container.textContent).toContain("Save to SCE");
    expect(container.textContent).not.toContain("+ Files…");
    expect(container.textContent).not.toContain("Open Workspace…");
    // Mass cytometry is gated pooled: the SCE opens with every sample selected and pooled, and the
    // pool is the tree, open to drawing.
    expect(container.querySelector(".gl-pool-toolbar")?.textContent).toContain("Pooled view · 2 samples");
    expect(container.textContent).toContain("Return to single sample");
    expect(plotHarness.eventCount).toBe(3);

    // The About card under the R host: the package's own name and artwork, the version said to be
    // the embedded core's, and a first step that exists here (the tutorial does not).
    const card = container.querySelector<HTMLElement>(".gl-brand-card")!;
    expect(container.querySelector<HTMLImageElement>("img.gl-brand-wordmark")!.alt).toBe("GateLabR");
    // The package's version and the commits it and its core were built from, as the host states
    // them: the app's version is the same from one embed to the next, the core's commit is not.
    expect(card.querySelector(".gl-brand-card-head")!.textContent).toMatch(/^GateLabR 1\.6\.0 \(0123456\) · GateLab core v\d+\.\d+\.\d+ \(89abcde\)/);
    expect(container.querySelector("header")!.textContent).toMatch(/GateLab core v\d+\.\d+\.\d+ · 89abcde ·/);
    expect(card.textContent).toContain("The Getting started guide on the documentation site (david-priest.github.io/GateLabR) covers a first session");
    expect(card.textContent).toContain("launchGatingApp(agent = TRUE)");
    expect(card.textContent).not.toContain("Tutorial in the header");

    await act(async () => {
      plotHarness.onNewGate?.({
        gate_type: "polygon",
        vertices: [[1, 2.7], [2.4, 2.8], [2, 3.1]],
        x_channel: "CD3",
        y_channel: "CD19",
      });
    });
    expect(container.textContent).toContain("Name this gate");
    const createGate = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Create")!;
    await act(async () => createGate.click());
    expect(container.textContent).toContain("Gate_1");

    const gateId = plotHarness.payload?.gates?.[0]?.gate_id;
    expect(gateId).toBeTruthy();
    const movedVertices: [number, number][] = [
      [1.1, 2.72],
      [2.45, 2.85],
      [2.05, 3.12],
    ];
    await act(async () => {
      plotHarness.onGateEdit?.({ gate_id: gateId!, vertices: movedVertices });
    });
    expect(plotHarness.payload?.gates?.[0]?.vertices).toEqual(movedVertices);
  });

  // A cluster label lives in colData, and the question "which clusters fall inside this gate"
  // needs it on the plot while the gate is being drawn. Only names travel with the dataset; the
  // values are fetched when the column is chosen, once, as one code per event.
  it("opens a flow SCE on one sample, with the selection ready to pool", async () => {
    const flowDataset: GateLabHostDatasetDescriptor = { ...dataset, instrument: "flow" };
    const host: GateLabHostAdapter = {
      contractVersion: GATELAB_HOST_CONTRACT_VERSION,
      id: "test-r-host",
      kind: "r-sce",
      label: "Test R host",
      capabilities: {
        dataSources: { fcsFiles: false, singleCellExperiment: true },
        dataModel: { multipleAssays: true, sampleMetadata: true, writeBackColumns: true },
        persistence: {
          workspaceFiles: false,
          hostObject: true,
          fileSystemAccess: false,
          directoryAccess: false,
        },
        compute: { location: "host" },
      },
      datasets: {
        async listDatasets() {
          return [flowDataset];
        },
        async readAssay(_datasetId, sampleId) {
          return sampleId === "sample-0"
            ? bufferOf(new Float32Array([5, 10, 20, 25]))
            : bufferOf(new Float32Array([15, 30]));
        },
        async readEventIndex(_datasetId, sampleId) {
          return sampleId === "sample-0"
            ? bufferOf(new Uint32Array([0, 2]))
            : bufferOf(new Uint32Array([1]));
        },
      },
    };

    await act(async () => {
      root.render(
        <GateLabHostProvider host={host}>
          <App />
        </GateLabHostProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(container.querySelector(".gl-pool-toolbar")?.textContent).toContain("Viewing: Donor B");
    expect(plotHarness.eventCount).toBe(1);
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.startsWith("Pool selected samples (2)"))!.click();
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    expect(container.querySelector(".gl-pool-toolbar")?.textContent).toContain("Pooled view · 2 samples");
    expect(plotHarness.eventCount).toBe(3);
  });

  it("colours the plot by a categorical colData column fetched on demand", async () => {
    const readCategoricalColumn = vi.fn(async (request: { columnName: string }) => ({
      columnName: request.columnName,
      levels: ["B", "T"],
      colors: ["#112233", "#445566"],
      sampleValues: [
        { sampleId: "sample-0", eventCount: 2, codesBase64: btoa(String.fromCharCode(0, 1)) },
        { sampleId: "sample-1", eventCount: 1, constantCode: 1 },
      ],
    }));
    const host: GateLabHostAdapter = {
      contractVersion: GATELAB_HOST_CONTRACT_VERSION,
      id: "test-r-host",
      kind: "r-sce",
      label: "Test R host",
      capabilities: {
        dataSources: { fcsFiles: false, singleCellExperiment: true },
        dataModel: { multipleAssays: true, sampleMetadata: true, writeBackColumns: true },
        persistence: {
          workspaceFiles: false,
          hostObject: true,
          fileSystemAccess: false,
          directoryAccess: false,
        },
        compute: { location: "host" },
      },
      datasets: {
        async listDatasets() {
          return [{
            ...dataset,
            colDataColumns: ["sample_id", "cluster", "score"],
            colDataCategorical: [{ name: "sample_id", levelCount: 2 }, { name: "cluster", levelCount: 2 }],
          }];
        },
        async readAssay(_datasetId, sampleId) {
          return sampleId === "sample-0"
            ? bufferOf(new Float32Array([5, 10, 20, 25]))
            : bufferOf(new Float32Array([15, 30]));
        },
        async readEventIndex(_datasetId, sampleId) {
          return sampleId === "sample-0"
            ? bufferOf(new Uint32Array([0, 2]))
            : bufferOf(new Uint32Array([1]));
        },
      },
      colData: {
        readCategoricalColumn,
        async writeColumns() { throw new Error("not under test"); },
        async writeCategoricalColumns() { throw new Error("not under test"); },
      },
    };

    await act(async () => {
      root.render(
        <GateLabHostProvider host={host}>
          <App />
        </GateLabHostProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(plotHarness.eventCount).toBe(3);

    // "Colour by" is a searchable picker: its options exist only while the panel is open.
    const openColourBy = () => {
      if (!container.querySelector(".gl-searchable-select-panel")) {
        act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Colour by"]')!.click());
      }
      return container.querySelector<HTMLSelectElement>(".gl-searchable-select-panel select")!;
    };
    const chooseColourBy = async (value: string) => {
      const list = openColourBy();
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(list, value);
        list.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    };

    openColourBy();
    const option = container.querySelector<HTMLOptionElement>('option[value="coldata:cluster"]');
    expect(option?.textContent).toBe("cluster (2)");
    // The numeric column is not offered: there is nothing categorical to colour by.
    expect(container.querySelector('option[value="coldata:score"]')).toBeNull();
    await chooseColourBy("coldata:cluster");

    expect(readCategoricalColumn).toHaveBeenCalledTimes(1);
    expect(readCategoricalColumn.mock.calls[0][0]).toMatchObject({ datasetId: "sce", columnName: "cluster" });
    const payload = plotHarness.payload as unknown as {
      color_palette?: string[];
      color_b64?: string;
    };
    // The legend is drawn beside the plot rather than inside the canvas.
    const legend = [...container.querySelectorAll(".gl-overlay-legend span")]
      .map((span) => span.textContent?.trim())
      .filter((text) => text);
    expect(legend).toEqual(["B", "T", "missing"]);
    // The host's fixed colours win over the palette choice, so the plot matches the R figures.
    expect(payload.color_palette?.slice(0, 2)).toEqual(["#112233", "#445566"]);
    expect([...Uint8Array.from(atob(payload.color_b64!), (c) => c.charCodeAt(0))]).toEqual([0, 1, 1]);

    // Choosing it again does not fetch again.
    await chooseColourBy("none");
    await chooseColourBy("coldata:cluster");
    expect(readCategoricalColumn).toHaveBeenCalledTimes(1);
  });

  it("restores legacy GateLabR gates and populations from SCE metadata", async () => {
    const writeWorkspace = vi.fn(async (request: {
      datasetId: string;
      expectedRevision: number;
      clientRevision: number;
      reason: "autosave" | "explicit";
      workspaceJson: string;
    }) => ({
      revision: request.expectedRevision + 1,
      clientRevision: request.clientRevision,
      savedAt: "2026-07-25T00:00:00Z",
    }));
    const host: GateLabHostAdapter = {
      contractVersion: GATELAB_HOST_CONTRACT_VERSION,
      id: "test-r-host",
      kind: "r-sce",
      label: "Test R host",
      capabilities: {
        dataSources: { fcsFiles: false, singleCellExperiment: true },
        dataModel: {
          multipleAssays: true,
          sampleMetadata: true,
          writeBackColumns: true,
        },
        persistence: {
          workspaceFiles: false,
          hostObject: true,
          fileSystemAccess: false,
          directoryAccess: false,
        },
        compute: { location: "host" },
      },
      datasets: {
        async listDatasets() {
          return [dataset];
        },
        async readAssay(_datasetId, sampleId) {
          return sampleId === "sample-0"
            ? bufferOf(new Float32Array([5, 10, 20, 25]))
            : bufferOf(new Float32Array([15, 30]));
        },
        async readEventIndex(_datasetId, sampleId) {
          return sampleId === "sample-0"
            ? bufferOf(new Uint32Array([0, 2]))
            : bufferOf(new Uint32Array([1]));
        },
      },
      workspaces: {
        async readWorkspace() {
          return {
            contractVersion: 1,
            datasetId: "sce",
            sourceFormat: "gatelabr-legacy",
            revision: 0,
            workspaceJson: JSON.stringify({
              gates: {
                "gate-restored": {
                  gate_id: "gate-restored",
                  name: "Saved CD3 gate",
                  gate_type: "rectangle",
                  x_channel: "CD3",
                  y_channel: "CD19",
                  vertices: [[1, 2.7], [2.4, 3.1]],
                  color: "#377eb8",
                  label_offset: null,
                },
              },
              gate_order: "gate-restored",
              populations: {
                root: {
                  population_id: "root",
                  name: "All Events",
                  gate_refs: [],
                  gate_logic: "and",
                  parent_id: null,
                  children: "saved-pop",
                },
                "saved-pop": {
                  population_id: "saved-pop",
                  name: "Saved population",
                  gate_refs: { gate_id: "gate-restored", include: true },
                  gate_logic: "and",
                  parent_id: "root",
                  children: [],
                },
              },
              root_population_id: "root",
              gate_value_space: "display",
              global_scale_ranges: {
                CD3: [0, 8],
                CD19: [0, 7],
              },
            }),
          };
        },
        writeWorkspace,
      },
    };

    await act(async () => {
      root.render(
        <GateLabHostProvider host={host}>
          <App />
        </GateLabHostProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(container.textContent).toContain("Saved CD3 gate");
    expect(container.textContent).toContain("Saved population");
    expect(container.textContent).toContain(
      "Restored 1 gate and 2 populations from GateLabR SCE metadata",
    );
    expect(plotHarness.payload?.gates?.[0]?.gate_id).toBe("gate-restored");
    expect(plotHarness.payload?.gates?.[0]?.vertices[0]).toEqual([1, 2.7]);
    expect(plotHarness.payload?.gates?.[0]?.vertices[2]).toEqual([2.4, 3.1]);

    const save = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.startsWith("Save to SCE"))!;
    await act(async () => {
      save.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(writeWorkspace).toHaveBeenCalledTimes(1);
    expect(writeWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      datasetId: "sce",
      expectedRevision: 0,
      reason: "explicit",
    }));
    const savedWorkspace = JSON.parse(writeWorkspace.mock.calls[0][0].workspaceJson);
    expect(savedWorkspace.version).toBe(2);
    expect(savedWorkspace.gating.gates["gate-restored"].vertices).toEqual([
      [1, 2.7],
      [2.4, 3.1],
    ]);
    expect(container.textContent).toContain("workspace revision 1 · saved");
  });

  // A gate on FlowJo's biex table needs a GateLab that has that table (workspaceFeatures.ts). Saved
  // to the SCE as version 2 with the feature listed beside it, a GateLabR embedding 0.8.3 opened it
  // as version 2 and misread the gate (a grid gate blanked the app). It is written as a file is:
  // version 4, which 0.8.3 refuses by its version.
  it("saves a workspace holding FlowJo's biex table to the SCE as a file is, version 4 with its feature listed", async () => {
    const writeWorkspace = vi.fn(async (request: {
      datasetId: string;
      expectedRevision: number;
      clientRevision: number;
      reason: "autosave" | "explicit";
      workspaceJson: string;
    }) => ({
      revision: request.expectedRevision + 1,
      clientRevision: request.clientRevision,
      savedAt: "2026-07-25T00:00:00Z",
    }));
    const host: GateLabHostAdapter = {
      contractVersion: GATELAB_HOST_CONTRACT_VERSION,
      id: "test-r-host",
      kind: "r-sce",
      label: "Test R host",
      capabilities: {
        dataSources: { fcsFiles: false, singleCellExperiment: true },
        dataModel: {
          multipleAssays: true,
          sampleMetadata: true,
          writeBackColumns: true,
        },
        persistence: {
          workspaceFiles: false,
          hostObject: true,
          fileSystemAccess: false,
          directoryAccess: false,
        },
        compute: { location: "host" },
      },
      datasets: {
        async listDatasets() {
          return [dataset];
        },
        async readAssay(_datasetId, sampleId) {
          return sampleId === "sample-0"
            ? bufferOf(new Float32Array([5, 10, 20, 25]))
            : bufferOf(new Float32Array([15, 30]));
        },
        async readEventIndex(_datasetId, sampleId) {
          return sampleId === "sample-0"
            ? bufferOf(new Uint32Array([0, 2]))
            : bufferOf(new Uint32Array([1]));
        },
      },
      workspaces: {
        async readWorkspace() {
          return {
            contractVersion: 1,
            datasetId: "sce",
            sourceFormat: "gatelabr-legacy",
            revision: 0,
            workspaceJson: JSON.stringify({
              gates: {
                "gate-restored": {
                  gate_id: "gate-restored",
                  name: "Saved CD3 gate",
                  gate_type: "rectangle",
                  x_channel: "CD3",
                  y_channel: "CD19",
                  vertices: [[1, 2.7], [2.4, 3.1]],
                  color: "#377eb8",
                  label_offset: null,
                  space: "display",
                  transforms: {
                    CD3: { kind: "biex", maxValue: 262144, pos: 4.41854, neg: 0, widthBasis: -10, channelRange: 256, tableChannels: 4096 },
                    CD19: { kind: "asinh", cofactor: 5 },
                  },
                },
              },
              gate_order: "gate-restored",
              populations: {
                root: {
                  population_id: "root",
                  name: "All Events",
                  gate_refs: [],
                  gate_logic: "and",
                  parent_id: null,
                  children: "saved-pop",
                },
                "saved-pop": {
                  population_id: "saved-pop",
                  name: "Saved population",
                  gate_refs: { gate_id: "gate-restored", include: true },
                  gate_logic: "and",
                  parent_id: "root",
                  children: [],
                },
              },
              root_population_id: "root",
              gate_value_space: "display",
              global_scale_ranges: {
                CD3: [0, 8],
                CD19: [0, 7],
              },
            }),
          };
        },
        writeWorkspace,
      },
    };

    await act(async () => {
      root.render(
        <GateLabHostProvider host={host}>
          <App />
        </GateLabHostProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(container.textContent).toContain("Saved CD3 gate");
    expect(container.textContent).toContain("Saved population");
    expect(container.textContent).toContain(
      "Restored 1 gate and 2 populations from GateLabR SCE metadata",
    );
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.startsWith("Save to SCE"))!;
    await act(async () => {
      save.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(writeWorkspace).toHaveBeenCalledTimes(1);
    const savedWorkspace = JSON.parse(writeWorkspace.mock.calls[0][0].workspaceJson);
    expect(savedWorkspace.version).toBe(4);
    expect(savedWorkspace.requiredFeatures).toEqual(["flowjo-biex-table"]);
    expect(savedWorkspace.gating.gates["gate-restored"].transforms.CD3.tableChannels).toBe(4096);
    expect(container.textContent).toContain("workspace revision 1 · saved");
  });
});

// The SCE advances on every accepted write, but the browser only learns the new revision from
// that write's reply. A reply lost to a closing session, a reconnect or a replaced tab therefore
// left the browser a revision behind for good: every later save failed the check and the only
// cure was reloading. Reported from a live session as
// "the browser expected revision 14 but the SCE is at revision 15".
describe("workspace revision conflicts", () => {
  const WRITER_ID = "00000000-0000-4000-8000-000000000001"; // the stubbed crypto.randomUUID

  function hostWith(
    writeWorkspace: GateLabHostAdapter["workspaces"] extends infer T
      ? T extends { writeWorkspace: infer W } ? W : never
      : never,
  ): GateLabHostAdapter {
    return {
      contractVersion: GATELAB_HOST_CONTRACT_VERSION,
      id: "test-r-host",
      kind: "r-sce",
      label: "Test R host",
      capabilities: {
        dataSources: { fcsFiles: false, singleCellExperiment: true },
        dataModel: { multipleAssays: true, sampleMetadata: true, writeBackColumns: true },
        persistence: {
          workspaceFiles: false,
          hostObject: true,
          fileSystemAccess: false,
          directoryAccess: false,
        },
        compute: { location: "host" },
      },
      datasets: {
        async listDatasets() { return [dataset]; },
        async readAssay(_datasetId, sampleId) {
          return sampleId === "sample-0"
            ? bufferOf(new Float32Array([5, 10, 20, 25]))
            : bufferOf(new Float32Array([15, 30]));
        },
        async readEventIndex(_datasetId, sampleId) {
          return sampleId === "sample-0"
            ? bufferOf(new Uint32Array([0, 2]))
            : bufferOf(new Uint32Array([1]));
        },
      },
      workspaces: {
        // The browser is told 14; the SCE has really reached 15 through a write it never heard
        // the reply to.
        async readWorkspace() {
          return {
            contractVersion: 1,
            datasetId: "sce",
            sourceFormat: "gatelabr-legacy" as const,
            revision: 14,
            workspaceJson: JSON.stringify({
              gates: {},
              gate_order: [],
              populations: {
                root: {
                  population_id: "root",
                  name: "All Events",
                  gate_refs: [],
                  gate_logic: "and",
                  parent_id: null,
                  children: [],
                },
              },
              root_population_id: "root",
              gate_value_space: "display",
              global_scale_ranges: { CD3: [0, 8], CD19: [0, 7] },
            }),
          };
        },
        writeWorkspace,
      },
    };
  }

  async function renderAndSave(host: GateLabHostAdapter) {
    await act(async () => {
      root.render(
        <GateLabHostProvider host={host}>
          <App />
        </GateLabHostProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.startsWith("Save to SCE"))!;
    await act(async () => {
      save.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }

  it("resyncs and retries when the conflicting write was this browser's own", async () => {
    let stored = 15; // the revision our own unheard write actually reached
    const writeWorkspace = vi.fn(async (request: {
      expectedRevision: number;
      clientRevision: number;
    }) => {
      if (request.expectedRevision !== stored) {
        throw new GateLabWorkspaceConflictError(
          `expected ${request.expectedRevision}, SCE at ${stored}`,
          { expectedRevision: request.expectedRevision, currentRevision: stored, writerId: WRITER_ID },
        );
      }
      stored += 1;
      return { revision: stored, clientRevision: request.clientRevision, savedAt: "2026-08-27T00:00:00Z" };
    });

    await renderAndSave(hostWith(writeWorkspace));

    // Once to discover the conflict, once more at the revision the conflict reported.
    expect(writeWorkspace).toHaveBeenCalledTimes(2);
    expect(writeWorkspace.mock.calls[0][0].expectedRevision).toBe(14);
    expect(writeWorkspace.mock.calls[1][0].expectedRevision).toBe(15);
    // Recovered without the user reloading, and without the conflict surfacing as an error.
    expect(container.textContent).toContain("Saved GateLab workspace to SCE · revision 16");
    expect(container.textContent).not.toContain("revision conflict");
  });

  it("stamps the write with this browser's writer id", async () => {
    const writeWorkspace = vi.fn(async (request: { expectedRevision: number; clientRevision: number }) => ({
      revision: request.expectedRevision + 1,
      clientRevision: request.clientRevision,
      savedAt: "2026-08-27T00:00:00Z",
    }));
    await renderAndSave(hostWith(writeWorkspace));
    expect(writeWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ writerId: WRITER_ID }),
    );
  });

  it("refuses to overwrite a genuine second session, and reports it", async () => {
    const writeWorkspace = vi.fn(async (request: { expectedRevision: number }) => {
      throw new GateLabWorkspaceConflictError(
        `Workspace revision conflict: the browser expected revision ${request.expectedRevision} ` +
          "but the SCE is at revision 15. Another session wrote to this SCE; reload GateLabR " +
          "before saving again.",
        { expectedRevision: request.expectedRevision, currentRevision: 15, writerId: "another-session" },
      );
    });

    await renderAndSave(hostWith(writeWorkspace));

    // No retry: someone else's work is not silently replaced, and the user is told.
    expect(writeWorkspace).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Another session wrote to this SCE");
  });
});

// The SCE's assays by name. An object usually holds compensated counts and a transformed exprs,
// corrected or not: the app opens on exprs drawn as stored, offers counts through its own
// arcsinh, and a workspace saved from the object records which assay it was drawn from.
describe("hosted assay choice", () => {
  const twoAssays: GateLabHostDatasetDescriptor = {
    ...dataset,
    assays: [
      { id: "exprs", label: "exprs", role: "transformed", coordinateSpace: "display", revision: 1, encoding: "channel-major-float32-le", displayCofactor: 5, displayCofactorStated: true },
      { id: "counts", label: "counts", role: "counts", coordinateSpace: "linear", revision: 2, encoding: "channel-major-float32-le" },
    ],
    defaultAssayId: "exprs",
  };
  const asinh5 = (value: number) => Math.asinh(value / 5);
  // exprs as an analysis leaves it: asinh(counts / 5) with a correction, here a shift of 0.1.
  const exprsOf = (counts: readonly number[]) => counts.map((value) => asinh5(value) + 0.1);
  const values = {
    counts: { "sample-0": [5, 10, 20, 25], "sample-1": [15, 30] },
    exprs: { "sample-0": exprsOf([5, 10, 20, 25]), "sample-1": exprsOf([15, 30]) },
  } as const;
  // The payload is Float32, so values agree with a double computation to four decimals, not six.
  const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => a - b).map((x) => Math.round(x * 1e4) / 1e4);
  const plotted = () => {
    const payload = plotHarness.payload as unknown as { x_b64: string; y_b64: string };
    return { x: sorted([...decodeFloat32Base64(payload.x_b64)]), y: sorted([...decodeFloat32Base64(payload.y_b64)]) };
  };
  const workspaceJson = (extra: Record<string, unknown>) => JSON.stringify({
    format: "gatelab-workspace", version: 2, workspaceId: "sce-workspace", savedAt: "2026-07-25T00:00:00Z", app: "GateLab",
    ...extra,
    samples: [
      { sampleId: "sce:sample-0", fileName: "Donor A", dataPath: "data/sce-1.fcs", logicleW: {}, scatterCofactor: {}, cytofCofactor: 5, compensationOn: false, instrumentMode: "cytof", labels: {}, metadata: {} },
      { sampleId: "sce:sample-1", fileName: "Donor B", dataPath: "data/sce-2.fcs", logicleW: {}, scatterCofactor: {}, cytofCofactor: 5, compensationOn: false, instrumentMode: "cytof", labels: {}, metadata: {} },
    ],
    activeSample: 0,
    gating: { gates: {}, gate_order: [], populations: { root: { population_id: "root", name: "All Events", gate_refs: [], gate_logic: "and", parent_id: null, children: [], event_count: 3, percent_of_parent: 100 } }, root_population_id: "root", active_population_id: "root", selected_gate_id: null },
    scales: { globalScales: {} },
    display: { xChannel: "CD3", yChannel: "CD19", mode: "pseudocolor", maxEvents: 50000, contourThreshold: 5 },
  });
  const assaySelect = () => container.querySelector<HTMLSelectElement>('select[aria-label="Active assay layer for all tabs"]')!;
  /** The files off the plot are gated between paints; the pooled counts land when they are done. */
  const pooledCountsReady = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const text = container.textContent ?? "";
      if (!text.includes("pooling…") && !text.includes("Pooling ")) return;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
    throw new Error("pooled counts never landed");
  };
  const instrumentSelect = () => [...container.querySelectorAll<HTMLSelectElement>("select")].find((s) => [...s.options].some((o) => o.value === "cytof"))!;
  const mountHost = async (saved: string | null, writeWorkspace = vi.fn(async (request: { expectedRevision: number; clientRevision: number; workspaceJson: string }) => ({
    revision: request.expectedRevision + 1, clientRevision: request.clientRevision, savedAt: "2026-07-25T00:00:00Z",
  })), hosted: GateLabHostDatasetDescriptor = twoAssays) => {
    const readAssay = vi.fn(async (_datasetId: string, sampleId: string, assayId: string) =>
      bufferOf(new Float32Array(values[assayId as "exprs" | "counts"][sampleId as "sample-0" | "sample-1"])));
    const host: GateLabHostAdapter = {
      contractVersion: GATELAB_HOST_CONTRACT_VERSION,
      id: "test-r-host", kind: "r-sce", label: "Test R host",
      capabilities: {
        dataSources: { fcsFiles: false, singleCellExperiment: true },
        dataModel: { multipleAssays: true, sampleMetadata: true, writeBackColumns: true },
        persistence: { workspaceFiles: false, hostObject: true, fileSystemAccess: false, directoryAccess: false },
        compute: { location: "host" },
      },
      datasets: {
        async listDatasets() { return [hosted]; },
        readAssay,
        async readEventIndex(_datasetId, sampleId) {
          return sampleId === "sample-0" ? bufferOf(new Uint32Array([0, 2])) : bufferOf(new Uint32Array([1]));
        },
      },
      workspaces: {
        async readWorkspace() {
          return saved === null ? null : { contractVersion: 1, datasetId: "sce", sourceFormat: "gatelab-workspace", revision: 1, workspaceJson: saved };
        },
        writeWorkspace,
      },
    };
    await act(async () => {
      root.render(<GateLabHostProvider host={host}><App /></GateLabHostProvider>);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    return { readAssay, writeWorkspace };
  };

  it("opens on exprs drawn as stored, draws counts through arcsinh when chosen, and saves the choice", async () => {
    const { readAssay, writeWorkspace } = await mountHost(null);
    expect(readAssay.mock.calls.map((call) => call[2])).toEqual(["exprs", "exprs"]);
    expect(assaySelect().value).toBe("assay:exprs");
    expect([...assaySelect().options].map((o) => o.textContent)).toEqual(["exprs · as stored", "counts"]);
    expect(instrumentSelect().disabled).toBe(false);
    expect(container.textContent).toContain("drawing exprs as stored");
    // The values as stored, on the arcsinh 5 axis they are in.
    expect(plotted()).toEqual({ x: sorted(exprsOf([5, 10, 15])), y: sorted(exprsOf([20, 25, 30])) });

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(assaySelect(), "assay:counts");
      assaySelect().dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(readAssay.mock.calls.slice(2).map((call) => call[2])).toEqual(["counts", "counts"]);
    expect(assaySelect().value).toBe("assay:counts");
    expect(instrumentSelect().disabled).toBe(false);
    expect(container.textContent).toContain("Drawing counts");
    expect(plotted()).toEqual({ x: sorted([5, 10, 15].map(asinh5)), y: sorted([20, 25, 30].map(asinh5)) });

    const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.startsWith("Save to SCE"))!;
    await act(async () => {
      save.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(writeWorkspace).toHaveBeenCalled();
    const savedWorkspace = JSON.parse(writeWorkspace.mock.calls.at(-1)![0].workspaceJson);
    expect(savedWorkspace.hostedAssayId).toBe("counts");
  });

  // A gate drawn on counts records arcsinh 5, and exprs is in that space: the gate keeps its
  // events when exprs is drawn. Drawn through the identity instead, its vertices were mapped
  // back through sinh to about 18 on an axis that ends near 3, it held no event, and clicking
  // it in the tree brought nothing onto the plot.
  it("keeps a gate drawn on counts when exprs is drawn, and brings a gate up from the tree", async () => {
    await mountHost(null);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(assaySelect(), "assay:counts");
      assaySelect().dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    // In arcsinh-5 space: holds sample-0's two events and not sample-1's, under counts and under
    // exprs alike.
    await act(async () => {
      plotHarness.onNewGate?.({
        gate_type: "rectangle",
        vertices: [[0.5, 2.0], [1.7, 2.45]],
        x_channel: "CD3",
        y_channel: "CD19",
      });
    });
    const createPop = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.parentElement?.textContent?.includes("Also create a population"))!;
    if (!createPop.checked) await act(async () => createPop.click());
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Create")!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await pooledCountsReady();
    expect(container.textContent).toContain("2 (66.67%) · pooled · 2 FCS");

    const chip = container.querySelector<HTMLElement>(".pop-tree-gate-badge")!;
    await act(async () => {
      chip.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(container.querySelector(".pop-tree-gate-badge.selected-gate")).not.toBeNull();
    const plotGates = () => (plotHarness.payload as unknown as { gates: { percent_of_parent?: number | null }[] }).gates;
    expect(plotGates()[0].percent_of_parent).toBe(66.67);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(assaySelect(), "assay:exprs");
      assaySelect().dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    await pooledCountsReady();
    expect(plotted().x).toEqual(sorted(exprsOf([5, 10, 15])));
    expect(container.textContent).toContain("2 (66.67%) · pooled · 2 FCS");
    expect(plotGates()[0].percent_of_parent).toBe(66.67);
  });

  it("reopens on the assay the saved workspace was drawn from", async () => {
    const { readAssay } = await mountHost(workspaceJson({ hostedAssayId: "counts" }));
    expect(readAssay.mock.calls.map((call) => call[2])).toEqual(["counts", "counts"]);
    expect(assaySelect().value).toBe("assay:counts");
    expect(plotted().x).toEqual(sorted([5, 10, 15].map(asinh5)));
  });

  it("reopens a workspace saved before the choice existed on the linear assay it was drawn from", async () => {
    const { readAssay } = await mountHost(workspaceJson({}));
    expect(readAssay.mock.calls.map((call) => call[2])).toEqual(["counts", "counts"]);
    expect(assaySelect().value).toBe("assay:counts");
  });

  it("opens a transformed-only object with a saved workspace on its exprs, there being no linear assay", async () => {
    const { readAssay } = await mountHost(workspaceJson({}), undefined, { ...twoAssays, assays: [twoAssays.assays[0]] });
    expect(readAssay.mock.calls.map((call) => call[2])).toEqual(["exprs", "exprs"]);
    expect(assaySelect().value).toBe("assay:exprs");
  });

  it("lists a display assay whose cofactor the object does not state as not drawable, and opens on counts", async () => {
    const { readAssay } = await mountHost(null, undefined, {
      ...twoAssays,
      assays: [{ ...twoAssays.assays[0], displayCofactor: undefined, displayCofactorStated: undefined }, twoAssays.assays[1]],
    });
    expect(readAssay.mock.calls.map((call) => call[2])).toEqual(["counts", "counts"]);
    expect(assaySelect().value).toBe("assay:counts");
    const exprsOption = [...assaySelect().options].find((o) => o.value === "assay:exprs")!;
    expect(exprsOption.textContent).toBe("exprs · needs its arcsinh cofactor");
    expect(exprsOption.disabled).toBe(true);
  });

  it("carries the instrument mode across a switch", async () => {
    await mountHost(null);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(instrumentSelect(), "flow");
      instrumentSelect().dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(instrumentSelect().value).toBe("flow");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(assaySelect(), "assay:counts");
      assaySelect().dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(assaySelect().value).toBe("assay:counts");
    expect(instrumentSelect().value).toBe("flow");
  });

  // A compensated layer is linear values beside counts. On a flow object with a spillover matrix
  // the header offered it while exprs was drawn, and choosing it compensated transformed values.
  it("offers no compensated layer while a display assay is drawn, and offers it again on counts", async () => {
    await mountHost(null, undefined, {
      ...twoAssays,
      instrument: "flow",
      compensationMatrix: {
        kind: "flow-spillover",
        name: "metadata(sce)$spillover_matrix",
        sourceChannels: ["Nd142Di", "Eu151Di"],
        receiverChannels: ["Nd142Di", "Eu151Di"],
        matrix: [[1, 0.1], [0.05, 1]],
      },
    });
    expect(assaySelect().value).toBe("assay:exprs");
    expect([...assaySelect().options].map((o) => o.value)).toEqual(["assay:exprs", "assay:counts"]);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(assaySelect(), "assay:counts");
      assaySelect().dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect([...assaySelect().options].map((o) => o.value)).toEqual(["assay:exprs", "assay:counts", "compensated"]);
  });
});

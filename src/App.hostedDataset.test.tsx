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
    expect(plotHarness.eventCount).toBe(3);

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
});

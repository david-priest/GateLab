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
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.startsWith("Pool selected files"))!.click();
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    expect(plotHarness.eventCount).toBe(3);

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Edit the tree")!.click();
    });
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
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.startsWith("Pool selected files"))!.click();
      await new Promise(resolve => setTimeout(resolve, 30));
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

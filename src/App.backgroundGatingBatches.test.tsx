// @vitest-environment jsdom

import { act, Profiler } from "react";
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

// An edit re-gates every pooled file that is not on the plot, in the background. One file per
// timer tick re-rendered the whole app once per file, so an edit over an SCE of 224 samples waited
// on 224 renders of the app while the gating itself took milliseconds.

const plotHarness = vi.hoisted(() => ({
  onNewGate: null as ((gate: {
    gate_type: "rectangle" | "polygon" | "quadrant";
    vertices: [number, number][];
    x_channel: string;
    y_channel: string;
  }) => void) | null,
}));

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: ({ onNewGate }: { onNewGate?: NonNullable<typeof plotHarness.onNewGate> }) => {
    plotHarness.onNewGate = onNewGate ?? null;
    return <div data-testid="gating-plot" />;
  },
}));

const SAMPLE_COUNT = 224;
const EVENTS_PER_SAMPLE = 4250;

function bufferOf(values: Float32Array | Uint32Array): ArrayBuffer {
  return values.buffer.slice(
    values.byteOffset,
    values.byteOffset + values.byteLength,
  ) as ArrayBuffer;
}

/** Two channels of deterministic values for one sample, channel-major. */
function sampleValues(sampleIndex: number): Float32Array {
  const values = new Float32Array(EVENTS_PER_SAMPLE * 2);
  let state = 12345 + sampleIndex;
  for (let index = 0; index < values.length; index++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    values[index] = (state / 2147483648) * 100;
  }
  return values;
}

const dataset: GateLabHostDatasetDescriptor = {
  contractVersion: GATELAB_DATASET_CONTRACT_VERSION,
  id: "sce",
  label: "Hosted SCE",
  instrument: "cytof",
  eventCount: SAMPLE_COUNT * EVENTS_PER_SAMPLE,
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
  samples: Array.from({ length: SAMPLE_COUNT }, (_, index) => ({
    id: `sample-${index}`,
    label: `D${index + 1}`,
    eventCount: EVENTS_PER_SAMPLE,
    metadata: {},
    assayByteLength: EVENTS_PER_SAMPLE * 2 * 4,
    eventIndexEncoding: "uint32-le" as const,
    eventIndexByteLength: EVENTS_PER_SAMPLE * 4,
  })),
};

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
      return [dataset];
    },
    async readAssay(_datasetId, sampleId) {
      return bufferOf(sampleValues(Number(sampleId.replace("sample-", ""))));
    },
    async readEventIndex(_datasetId, sampleId) {
      const offset = Number(sampleId.replace("sample-", "")) * EVENTS_PER_SAMPLE;
      return bufferOf(Uint32Array.from({ length: EVENTS_PER_SAMPLE }, (_, index) => offset + index));
    },
  },
};

let root: Root;
let container: HTMLDivElement;
let commits = 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  plotHarness.onNewGate = null;
  commits = 0;
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

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.startsWith(label));
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Waits until the population tree has pooled counts for every sample. */
async function countsReady(): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (!container.textContent?.includes("Pooling ")) return;
    await settle(25);
  }
  throw new Error("pooled counts never completed");
}

describe("background gating of pooled files", () => {
  it("re-gates 224 SCE samples after an edit in a few renders, not one per sample", async () => {
    await act(async () => {
      root.render(
        <Profiler id="app" onRender={() => { commits++; }}>
          <GateLabHostProvider host={host}>
            <App />
          </GateLabHostProvider>
        </Profiler>,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await settle(50);
    expect(container.textContent).toContain(`${SAMPLE_COUNT} samples`);

    await act(async () => button("Pool selected files")?.click());
    await act(async () => button("Edit the tree")?.click());
    await countsReady();

    commits = 0;
    await act(async () => {
      plotHarness.onNewGate?.({
        gate_type: "rectangle",
        vertices: [[10, 10], [60, 10], [60, 60], [10, 60]],
        x_channel: "CD3",
        y_channel: "CD19",
      });
    });
    await act(async () => button("Create")?.click());
    await countsReady();
    expect(container.textContent).toContain(`Pooled counts: ${SAMPLE_COUNT} FCS`);
    expect(container.textContent).toContain("Gate_1");
    expect(commits).toBeLessThan(SAMPLE_COUNT / 4);
  }, 60_000);
});

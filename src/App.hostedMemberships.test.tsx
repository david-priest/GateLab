// @vitest-environment jsdom
// Save to SCE and Export populations to colData, with a file tailored against the tree: each SCE
// sample's memberships must come from the tree that sample is gated under, whichever tree is live
// when the user saves. Synthetic samples D1 and D2; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { GateLabHostProvider } from "./host/HostContext";
import {
  GATELAB_DATASET_CONTRACT_VERSION,
  type GateLabHostDatasetDescriptor,
} from "./host/datasetContract";
import { GATELAB_HOST_CONTRACT_VERSION, type GateLabHostAdapter } from "./host/contracts";
import type { GateLabHostPopulationColumn } from "./host/colDataContract";
import type { GateLabHostWorkspaceMemberships } from "./host/workspaceContract";

const plotHarness: { props: Record<string, any> | null } = { props: null };
vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: (props: Record<string, any>) => { plotHarness.props = props; return <div data-testid="gating-plot" />; },
}));

function bufferOf(values: Float32Array | Uint32Array): ArrayBuffer {
  return values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength) as ArrayBuffer;
}

// CyTOF gates live in display space, arcsinh with cofactor 5. Every event of both samples sits at
// CD19 = 1 and at CD3 = 1, 2, 3 and 4, so a CD3 interval says exactly which events are inside.
const raw = (display: number) => 5 * Math.sinh(display);
const CD3 = [1, 2, 3, 4].map(raw);
const CD19 = [1, 1, 1, 1].map(raw);
// The tree's gate holds CD3 1 and 2; D2's tailored copy of it holds CD3 2, 3 and 4.
const TREE_GATE: [number, number][] = [[0.5, 0], [2.5, 2]];
const TAILORED_GATE: [number, number][] = [[1.5, 0], [4.5, 2]];
const TREE_BITS = [1, 1, 0, 0];
const TAILORED_BITS = [0, 1, 1, 1];
// Whichever hierarchy R reads, D1 is gated under the tree and D2 under its own copy of it.
const EVERY_SAMPLE_UNDER_ITS_OWN_TREE = {
  gates: ["CD3 gate"],
  bits: { "sample-0": TREE_BITS, "sample-1": TAILORED_BITS },
};

const dataset: GateLabHostDatasetDescriptor = {
  contractVersion: GATELAB_DATASET_CONTRACT_VERSION,
  id: "sce",
  label: "Hosted SCE",
  instrument: "cytof",
  eventCount: 8,
  channels: [
    { id: "CD3", label: "CD3", pnn: "Nd142Di", pns: "CD3" },
    { id: "CD19", label: "CD19", pnn: "Eu151Di", pns: "CD19" },
  ],
  assays: [{
    id: "counts", label: "counts", role: "counts", coordinateSpace: "linear", revision: 0,
    encoding: "channel-major-float32-le",
  }],
  defaultAssayId: "counts",
  samples: ["D1", "D2"].map((label, index) => ({
    id: `sample-${index}`, label, eventCount: 4, metadata: {},
    assayByteLength: 32, eventIndexEncoding: "uint32-le" as const, eventIndexByteLength: 16,
  })),
};

const legacyWorkspace = JSON.stringify({
  gates: {
    "gate-cd3": {
      gate_id: "gate-cd3", name: "CD3 gate", gate_type: "rectangle", x_channel: "CD3", y_channel: "CD19",
      vertices: TREE_GATE, color: "#377eb8", label_offset: null,
    },
  },
  gate_order: "gate-cd3",
  populations: {
    root: { population_id: "root", name: "All Events", gate_refs: [], gate_logic: "and", parent_id: null, children: "pos" },
    pos: { population_id: "pos", name: "CD3 pos", gate_refs: { gate_id: "gate-cd3", include: true }, gate_logic: "and", parent_id: "root", children: [] },
  },
  root_population_id: "root",
  gate_value_space: "display",
  global_scale_ranges: { CD3: [0, 5], CD19: [0, 5] },
});

function makeHost() {
  const writes: Array<{ reason: string; memberships?: GateLabHostWorkspaceMemberships }> = [];
  const columnWrites: GateLabHostPopulationColumn[][] = [];
  const host: GateLabHostAdapter = {
    contractVersion: GATELAB_HOST_CONTRACT_VERSION,
    id: "test-r-host",
    kind: "r-sce",
    label: "Test R host",
    capabilities: {
      dataSources: { fcsFiles: false, singleCellExperiment: true },
      dataModel: { multipleAssays: true, sampleMetadata: true, writeBackColumns: true },
      persistence: { workspaceFiles: false, hostObject: true, fileSystemAccess: false, directoryAccess: false },
      compute: { location: "host" },
    },
    datasets: {
      async listDatasets() { return [dataset]; },
      async readAssay() { return bufferOf(Float32Array.from([...CD3, ...CD19])); },
      async readEventIndex(_datasetId, sampleId) {
        const offset = sampleId === "sample-0" ? 0 : 4;
        return bufferOf(Uint32Array.from([0, 1, 2, 3].map((i) => i + offset)));
      },
    },
    workspaces: {
      async readWorkspace() {
        return { contractVersion: 1, datasetId: "sce", sourceFormat: "gatelabr-legacy" as const, revision: 0, workspaceJson: legacyWorkspace };
      },
      async writeWorkspace(request) {
        writes.push({ reason: request.reason, memberships: request.memberships });
        return { revision: request.expectedRevision + 1, clientRevision: request.clientRevision, savedAt: "2026-09-24T00:00:00Z" };
      },
    },
    colData: {
      async writeColumns(request) {
        columnWrites.push([...request.columns]);
        return { columns: request.columns.map(({ columnName, populationId }) => ({ columnName, populationId, memberCount: 0 })) };
      },
      async writeCategoricalColumns() { throw new Error("not under test"); },
    },
  };
  return { host, writes, columnWrites };
}

const bitsOf = (base64: string, count: number) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return Array.from({ length: count }, (_, i) => (bytes[i >> 3] >> (i & 7)) & 1);
};

let root: Root;
let container: HTMLDivElement;
let uuid = 0;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  plotHarness.props = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  uuid = 0;
});

async function settle(): Promise<void> { await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); }
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim().startsWith(label))!;
const fileRow = (name: string) => [...container.querySelectorAll<HTMLElement>(".gl-sample-row")].find((r) => r.textContent?.includes(name))!;
async function view(name: string) { act(() => fileRow(name).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }))); await settle(); }
async function edit(mode: "tree" | "file") { act(() => container.querySelector<HTMLButtonElement>(`.population-tree-edit-${mode}`)!.click()); await settle(); }
async function saveToSce() { act(() => button("Save to SCE").click()); await settle(); }

/** Each hierarchy's "CD3 pos" as R receives it: sample id → membership bits, plus the gate names. */
function positives(memberships: GateLabHostWorkspaceMemberships) {
  return Object.fromEntries(memberships.hierarchies.map((hierarchy) => {
    const pos = memberships.populations.find((p) => p.hierarchyId === hierarchy.id && p.populationName === "CD3 pos")!;
    return [hierarchy.active ? "live" : "parked", {
      gates: pos.gates.map((g) => g.gateName),
      bits: Object.fromEntries(pos.sampleMasks.map((m) => [m.sampleId, bitsOf(m.membershipBitsBase64, m.eventCount)])),
    }];
  }));
}

describe("SCE memberships under per-file trees", () => {
  it("reads every sample under the tree it is gated under, in Save to SCE and in colData", async () => {
    const { host, writes, columnWrites } = makeHost();
    await act(async () => {
      root.render(<GateLabHostProvider host={host}><App /></GateLabHostProvider>);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await settle();
    expect(container.textContent).toContain("CD3 pos");

    // D2 tailors the tree's gate: its own copy becomes live while it is viewed in "this file only".
    await view("D2");
    await edit("file");
    const gateId = plotHarness.props!.payload.gates[0].gate_id;
    act(() => plotHarness.props!.onGateEdit({ gate_id: gateId, vertices: TAILORED_GATE }));
    await settle();
    expect(fileRow("D2").querySelector(".gl-sample-tailored")).not.toBeNull();

    // Saved with D2's copy live and the tree parked.
    await saveToSce();
    const copyLive = writes.filter((w) => w.reason === "explicit").at(-1)!.memberships!;
    expect(copyLive.hierarchies).toHaveLength(2);
    expect(positives(copyLive)).toEqual({ live: EVERY_SAMPLE_UNDER_ITS_OWN_TREE, parked: EVERY_SAMPLE_UNDER_ITS_OWN_TREE });

    // Saved with the tree live and D2's copy parked.
    await edit("tree");
    await saveToSce();
    const treeLive = writes.filter((w) => w.reason === "explicit").at(-1)!.memberships!;
    expect(treeLive.hierarchies).toHaveLength(2);
    expect(positives(treeLive)).toEqual({ live: EVERY_SAMPLE_UNDER_ITS_OWN_TREE, parked: EVERY_SAMPLE_UNDER_ITS_OWN_TREE });

    // colData from the tree: D2's column comes from its tailored gate.
    act(() => button("Export populations to colData").click());
    await settle();
    act(() => [...container.querySelectorAll<HTMLButtonElement>(".gl-sce-coldata-toolbar button")].find((b) => b.textContent === "All")!.click());
    act(() => [...container.querySelectorAll<HTMLButtonElement>(".gl-sce-coldata-modal button")].find((b) => /^Export/.test(b.textContent ?? ""))!.click());
    await settle();
    expect(columnWrites).toHaveLength(1);
    const column = columnWrites[0].find((c) => c.populationName === "CD3 pos")!;
    expect(Object.fromEntries(column.sampleMasks.map((m) => [m.sampleId, bitsOf(m.membershipBitsBase64, m.eventCount)])))
      .toEqual({ "sample-0": TREE_BITS, "sample-1": TAILORED_BITS });

    // And from D2's copy, live again: D1's column comes from the tree.
    await view("D2");
    await edit("file");
    act(() => button("Export populations to colData").click());
    await settle();
    act(() => [...container.querySelectorAll<HTMLButtonElement>(".gl-sce-coldata-toolbar button")].find((b) => b.textContent === "All")!.click());
    const overwrite = [...container.querySelectorAll<HTMLInputElement>(".gl-sce-coldata-modal input[type=checkbox]")].find((i) => i.closest("label")?.textContent?.includes("Overwrite"));
    if (overwrite && !overwrite.checked) act(() => overwrite.click());
    act(() => [...container.querySelectorAll<HTMLButtonElement>(".gl-sce-coldata-modal button")].find((b) => /^Export/.test(b.textContent ?? ""))!.click());
    await settle();
    expect(columnWrites).toHaveLength(2);
    const fromCopy = columnWrites[1].find((c) => c.populationName === "CD3 pos")!;
    expect(Object.fromEntries(fromCopy.sampleMasks.map((m) => [m.sampleId, bitsOf(m.membershipBitsBase64, m.eventCount)])))
      .toEqual({ "sample-0": TREE_BITS, "sample-1": TAILORED_BITS });
  });
});

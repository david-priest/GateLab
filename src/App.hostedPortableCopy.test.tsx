// @vitest-environment jsdom
// The R host menu's Save Portable Copy, in the app: the copy it downloads gates every population of
// every sample as Save to SCE says the session does, with D2 tailored, and opens in the standalone
// app with each file's own count. Synthetic samples D1 and D2; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { GateLabHostProvider } from "./host/HostContext";
import { GATELAB_DATASET_CONTRACT_VERSION, type GateLabHostDatasetDescriptor } from "./host/datasetContract";
import { GATELAB_HOST_CONTRACT_VERSION, type GateLabHostAdapter } from "./host/contracts";
import type { GateLabHostWorkspaceMemberships } from "./host/workspaceContract";
import { evaluateWorkspaceArchive } from "./headless/evaluate";

const plotHarness: { props: Record<string, any> | null } = { props: null };
vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: (props: Record<string, any>) => { plotHarness.props = props; return <div data-testid="gating-plot" />; },
}));
vi.mock("./engine/workspaceHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/workspaceHistory")>();
  return { ...actual, listWorkspaceCheckpoints: vi.fn(async () => []), saveWorkspaceCheckpoint: vi.fn(async () => "saved"), requestPersistentWorkspaceHistory: vi.fn(async () => null) };
});

function bufferOf(values: Float32Array | Uint32Array): ArrayBuffer {
  return values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength) as ArrayBuffer;
}

// CyTOF gates are in display units, arcsinh at cofactor 5. Every event sits at CD19 = 1 and at CD3
// = 1, 2, 3 and 4: the tree's gate holds CD3 1 and 2 (2 events), D2's tailored copy 2, 3 and 4 (3).
const raw = (display: number) => 5 * Math.sinh(display);
const CD3 = [1, 2, 3, 4].map(raw);
const CD19 = [1, 1, 1, 1].map(raw);
const TREE_GATE: [number, number][] = [[0.5, 0], [2.5, 2]];
const TAILORED_GATE: [number, number][] = [[1.5, 0], [4.5, 2]];

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
  assays: [{ id: "counts", label: "counts", role: "counts", coordinateSpace: "linear", revision: 0, encoding: "channel-major-float32-le" }],
  defaultAssayId: "counts",
  samples: ["D1", "D2"].map((label, index) => ({
    id: `sample-${index}`, label, eventCount: 4, metadata: {},
    assayByteLength: 32, eventIndexEncoding: "uint32-le" as const, eventIndexByteLength: 16,
  })),
};

const legacyWorkspace = JSON.stringify({
  gates: {
    "gate-cd3": { gate_id: "gate-cd3", name: "CD3 gate", gate_type: "rectangle", x_channel: "CD3", y_channel: "CD19", vertices: TREE_GATE, color: "#377eb8", label_offset: null },
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
  const host: GateLabHostAdapter = {
    contractVersion: GATELAB_HOST_CONTRACT_VERSION,
    id: "test-r-host",
    kind: "r-sce",
    label: "Test R host",
    capabilities: {
      dataSources: { fcsFiles: false, singleCellExperiment: true },
      dataModel: { multipleAssays: true, sampleMetadata: true, writeBackColumns: false },
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
  };
  return { host, writes };
}

const bitsOf = (base64: string, count: number) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return Array.from({ length: count }, (_, i) => (bytes[i >> 3] >> (i & 7)) & 1);
};

function fileOf(name: string, data: Uint8Array): File {
  const file = new File([data as BlobPart], name);
  Object.defineProperty(file, "arrayBuffer", { value: async () => data.slice().buffer });
  Object.defineProperty(file, "stream", {
    value: () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data.slice()); controller.close(); } }),
  });
  return file;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  }));
}

let root: Root;
let container: HTMLDivElement;
let uuid = 0;
const downloads: { name: string; blob: Blob }[] = [];
const realCrypto = globalThis.crypto;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", {
    subtle: realCrypto.subtle,
    getRandomValues: <T extends ArrayBufferView>(a: T) => realCrypto.getRandomValues(a as never) as T,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  });
  downloads.length = 0;
  URL.createObjectURL = (blob: Blob) => { downloads.push({ name: "", blob }); return "blob:copy"; };
  URL.revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    if (downloads.length) downloads[downloads.length - 1].name = this.download;
  });
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
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim().startsWith(label));
const fileRow = (name: string) => [...container.querySelectorAll<HTMLElement>(".gl-sample-row")].find((r) => r.textContent?.includes(name))!;
async function view(name: string) { act(() => fileRow(name).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }))); await settle(); }
const posCount = () => {
  const row = [...container.querySelectorAll(".pop-row")].map((r) => r.textContent?.replace(/\s+/g, " ").trim()).find((t) => t?.startsWith("CD3 pos"));
  return /CD3 gate\+(\d+)\(/.exec(row ?? "")?.[1] ?? "none";
};

describe("Save Portable Copy under the R host", () => {
  it("downloads a copy that gates as Save to SCE says and opens in the standalone app with each file's own count", async () => {
    const { host, writes } = makeHost();
    await act(async () => {
      root.render(<GateLabHostProvider host={host}><App /></GateLabHostProvider>);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await settle();
    expect(container.textContent).toContain("CD3 pos");

    // D2 tailors the tree's gate: switch on, then a drag.
    await view("D2");
    const card = [...container.querySelectorAll<HTMLElement>(".gate-card")][0];
    const toggle = card.querySelector<HTMLInputElement>(".gate-tailor-switch input")!;
    if (!toggle.checked) act(() => toggle.click());
    await settle();
    const gateId = plotHarness.props!.payload.gates[0].gate_id;
    act(() => plotHarness.props!.onGateEdit({ gate_id: gateId, vertices: TAILORED_GATE }));
    await settle();

    act(() => button("Save to SCE")!.click());
    await settle();
    const live = writes.filter((w) => w.reason === "explicit").at(-1)!.memberships!;

    const save = button("Save Portable Copy");
    expect(save).toBeTruthy();
    await act(async () => { save!.click(); });
    for (let i = 0; i < 4; i++) await settle();
    expect(container.textContent).toContain("Saved portable copy · Hosted_SCE.gatelab");
    expect(container.textContent).toContain("populations checked in 2 samples, event by event");
    expect(downloads.map((d) => d.name)).toEqual(["Hosted_SCE.gatelab"]);
    const bytes = await blobBytes(downloads[0].blob);

    // The copy, gated by the engine: every population of every hierarchy, sample by sample, as Save to SCE.
    const copy = await evaluateWorkspaceArchive(bytes);
    expect(copy.samples.map((s) => s.fileName)).toEqual(["D1.fcs", "D2.fcs"]);
    expect(copy.memberships.populations.length).toBe(live.populations.length);
    for (const p of live.populations) {
      const other = copy.memberships.populations.find((x) => x.hierarchyId === p.hierarchyId && x.populationId === p.populationId)!;
      expect(other, p.populationName).toBeTruthy();
      expect(other.sampleMasks.map((m) => bitsOf(m.membershipBitsBase64, m.eventCount)))
        .toEqual(p.sampleMasks.map((m) => bitsOf(m.membershipBitsBase64, m.eventCount)));
    }
    const pos = live.populations.find((p) => p.populationName === "CD3 pos" && live.hierarchies.find((h) => h.id === p.hierarchyId)?.active)!;
    expect(pos.sampleMasks.map((m) => bitsOf(m.membershipBitsBase64, m.eventCount))).toEqual([[1, 1, 0, 0], [0, 1, 1, 1]]);

    // Opened in the standalone app with nothing to relink: each file shows its own count.
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<App />));
    await settle();
    const input = container.querySelector<HTMLInputElement>('input[type="file"][accept*=".gatelab"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [fileOf("Hosted_SCE.gatelab", bytes)] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    for (let i = 0; i < 4; i++) await settle();
    expect(container.textContent).toContain("D1.fcs");
    expect(container.textContent).toContain("D2.fcs");
    await view("D1.fcs");
    expect(posCount()).toBe("2");
    await view("D2.fcs");
    expect(posCount()).toBe("3");
  });
});

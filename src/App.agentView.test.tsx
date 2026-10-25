// @vitest-environment jsdom
// Exercise the mounted App's adapter and the real protocol handler: a mock adapter whose
// settled() always resolves cannot detect a request waiting for a React commit that never comes.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHandler, StrategyReviewer } from "./agent/handler";
import type { AgentDescribe, AgentResponse, AgentView, AgentViewParams } from "./agent/protocol";
import type { FcsFile } from "./engine/fcs";

const agent = vi.hoisted(() => ({ handler: null as (AgentHandler & StrategyReviewer) | null }));
vi.mock("./agent/agentLink", async (original) => ({
  ...await original<typeof import("./agent/agentLink")>(),
  AgentLink: class {
    constructor(options: { handler: AgentHandler & StrategyReviewer }) { agent.handler = options.handler; }
    notifyChanged() {}
    disconnect() {}
  },
}));
vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => <div data-testid="gating-plot" />,
}));
vi.mock("./engine/fcs", async (original) => ({
  ...await original<typeof import("./engine/fcs")>(),
  parseFcs: (bytes: ArrayBuffer): FcsFile => ({
    version: "FCS3.1", nEvents: 4, instrument: "flow", keywords: {}, spillover: null,
    channels: ["FSC-A", "SSC-A", "CD4"].map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
    columns: [0, 1, 2].map((axis) => Float32Array.from([1, 2, 3, 4], (v) => 100 * (axis + new Uint8Array(bytes)[0]) + v)),
  }),
}));
import App from "./App";
import { StrategyProposalReview } from "./ui/StrategyProposalReview";

let root: Root;
let container: HTMLDivElement;
let uuid = 0;
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
const describeApp = async () => (await agent.handler!.handle({ kind: "request", id: "describe", method: "describe", params: {} })).result as AgentDescribe;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<App />));
  const input = [...container.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')].find((el) => !el.hasAttribute("webkitdirectory"))!;
  const files = [1, 2].map((n) => {
    const bytes = Uint8Array.of(n);
    const file = new File([bytes], `D${n}.fcs`);
    Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
    return file;
  });
  Object.defineProperty(input, "files", { value: files });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle(); await settle();
  expect((await describeApp()).samples).toHaveLength(2);
});
afterEach(() => {
  act(() => root.unmount()); container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); agent.handler = null; uuid = 0;
});

async function view(params: AgentViewParams): Promise<AgentView> {
  let response: AgentResponse | undefined;
  // Do not await the response inside act: React must be allowed to commit the requested view.
  act(() => { void agent.handler!.handle({ kind: "request", id: "view", method: "view", params }).then((r) => { response = r; }); });
  for (let i = 0; i < 4 && !response; i++) await settle();
  expect(response, "view must answer without an unrelated state change or relay timeout").toBeDefined();
  expect(response!.error).toBeUndefined();
  return response!.result as AgentView;
}

async function request(method: string, params: unknown = {}) {
  let response: AgentResponse | undefined;
  act(() => { void agent.handler!.handle({ kind: "request", id: method, method, params } as any).then((r) => { response = r; }); });
  for (let i = 0; i < 6 && !response; i++) await settle();
  expect(response).toBeDefined();
  return response!;
}
async function apply(command: unknown, expectedRevision?: number) {
  return request("apply", { command, expectedRevision: expectedRevision ?? (await describeApp()).revision, rationale: "Synthetic file-specific edit check" });
}
async function cellsFixture() {
  const d = await describeApp();
  await view({ sampleId: d.samples[0].id });
  const made = await apply({ type: "createGate", shape: "rectangle", name: "Cells", parentId: d.rootPopulationId, x: "FSC-A", y: "SSC-A", space: "display", vertices: [[100, 200], [203.5, 303.5]] });
  expect(made.error).toBeUndefined();
  const current = await describeApp();
  return { d: current, gateId: current.gates.find((g) => g.name === "Cells")!.id };
}
async function tailorCells() {
  const row = [...container.querySelectorAll<HTMLElement>(".gate-card")].find((r) => r.querySelector(".gate-card-name")?.textContent === "Cells")!;
  const toggle = row.querySelector<HTMLInputElement>(".gate-tailor-switch input")!;
  expect(toggle.checked).toBe(false);
  act(() => toggle.click()); await settle();
  expect(toggle.checked).toBe(true);
}
async function pendingGroupTarget(d: AgentDescribe) {
  act(() => container.querySelector<HTMLButtonElement>(".gl-sample-group-new")!.click()); await settle();
  const name = container.querySelector<HTMLInputElement>(".gl-modal input")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Group A"); name.dispatchEvent(new Event("input", { bubbles: true })); });
  act(() => [...container.querySelectorAll<HTMLButtonElement>(".gl-modal button")].find((b) => b.textContent === "Create")!.click()); await settle();
  await view({ sampleId: d.samples[0].id });
  const row = container.querySelector<HTMLElement>(".gate-card")!;
  act(() => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))); await settle();
  act(() => container.querySelector<HTMLButtonElement>(".scope-menu-tailor-group")!.click()); await settle();
}
async function cellsMembers() {
  const r = (await request("memberships")).result as any;
  const d = await describeApp();
  return cellsMembersFrom(r, d);
}
function cellsMembersFrom(r: any, d: AgentDescribe) {
  const pop = r.populations.find((p: any) => p.name === "Cells");
  return Object.fromEntries(d.samples.map((s, i) => {
    const packed = pop.sampleMasks.find((m: any) => m.sampleId === s.id);
    const bytes = Buffer.from(packed.membershipBitsBase64, "base64");
    expect(packed.eventCount).toBe(4);
    expect(bytes).toHaveLength(1);
    const ids = i === 0 ? [101, 102, 103, 104] : [201, 202, 203, 204];
    return [s.name, ids.filter((_, index) => (bytes[index >> 3] & (1 << (index & 7))) !== 0)];
  }));
}

describe("agent edits under per-gate tailoring", () => {
  it("names the shared tree as well as following group copies in a shared edit warning", async () => {
    const { d, gateId } = await cellsFixture(); await pendingGroupTarget(d);
    act(() => container.querySelector<HTMLElement>(".gate-card")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))); await settle();
    act(() => container.querySelector<HTMLButtonElement>(".scope-menu-cancel")!.click()); await settle();
    const review = agent.handler!.previewStrategy({ source: "host", by: "Synthetic host", rationale: "Check the shared edit warning", steps: [{ key: "edit", command: { type: "editGate", gateId, vertices: [[103, 203], [204.5, 304.5]] } }], targets: { Cells: d.populations.find((p) => p.name === "Cells")!.id } });
    const markup = renderToStaticMarkup(<StrategyProposalReview review={review} note={null} busy={false} onAccept={() => {}} onReject={() => {}} />);
    expect(markup).toContain("Cells (tree, group: Group A)");
  });

  it("replays an existing tailored gate proposal with exactly the memberships its commands apply", async () => {
    const { d, gateId } = await cellsFixture(); await tailorCells();
    const before = await describeApp();
    const command = { type: "editGate", gateId, vertices: [[103, 203], [204.5, 304.5]] };
    const populationId = d.populations.find((p) => p.name === "Cells")!.id;
    const response = await request("proposal", { expectedRevision: before.revision, sampleIds: d.samples.map((s) => s.id), populationIds: [populationId], steps: [{ key: "edit", command }] });
    expect(response.error).toBeUndefined();
    const proposed = response.result as any;
    const expected = { "D1.fcs": [103, 104], "D2.fcs": [201, 202, 203] };
    expect(cellsMembersFrom(proposed.memberships, d)).toEqual(expected);
    expect(proposed.describe.gates.find((g: any) => g.id === gateId).vertices).toEqual(command.vertices);
    expect((await describeApp()).revision).toBe(before.revision);
    expect(await cellsMembers()).toEqual({ "D1.fcs": [101, 102, 103, 104], "D2.fcs": [201, 202, 203] });
    expect((await apply(command, before.revision)).error).toBeUndefined();
    expect(await cellsMembers()).toEqual(expected);
  });

  it("previews a host proposal on the pending group copy, then applies it as one undo step and consumes the scope", async () => {
    const { d, gateId } = await cellsFixture(); await pendingGroupTarget(d);
    const before = await describeApp();
    expect(before.gates[0].editing).toMatchObject({ target: { kind: "group", name: "Group A" }, pending: true });
    const command = { type: "editGate" as const, gateId, vertices: [[103, 203], [204.5, 304.5]] as [number, number][] };
    const populationId = d.populations.find((p) => p.name === "Cells")!.id;
    const review = agent.handler!.previewStrategy({ source: "host", by: "Synthetic host", rationale: "Check the requested edit owner", steps: [{ key: "edit", command }], targets: { Cells: populationId } });
    expect(review.populations.find((p) => p.name === "Cells")!.counts.map((c) => c.n)).toEqual([2, 4]);
    expect(review.changes.changedGateIds).toEqual([gateId]);
    expect(review.changes.scopedGateChanges).toEqual([expect.objectContaining({ canonicalGateId: gateId, name: "Cells", scope: "group", ownerName: "Group A" })]);
    const markup = renderToStaticMarkup(<StrategyProposalReview review={review} note={null} busy={false} onAccept={() => {}} onReject={() => {}} />);
    expect(markup).toContain("It changes gates or populations already there:");
    expect(markup).toContain("Cells (group: Group A)");
    expect((await describeApp()).revision).toBe(before.revision);
    expect((await describeApp()).gates[0].editing).toEqual(before.gates[0].editing);
    let applied = false;
    act(() => { void agent.handler!.applyStrategy(review).then(() => { applied = true; }); });
    for (let i = 0; i < 6 && !applied; i++) await settle();
    expect(applied).toBe(true);
    expect(await cellsMembers()).toEqual({ "D1.fcs": [103, 104], "D2.fcs": [201, 202, 203, 204] });
    expect((await describeApp()).gates[0].editing).toMatchObject({ owner: { kind: "group" }, pending: false });
    expect((await apply({ type: "undo" })).error).toBeUndefined();
    const after = await describeApp();
    expect(after.gates[0].editing).toMatchObject({ pending: false });
    expect(await cellsMembers()).toEqual({ "D1.fcs": [101, 102, 103, 104], "D2.fcs": [201, 202, 203] });
  });

  it("previews and edits D1's actual gate while the shared tree stays active, then reads it back and undoes/redoes it", async () => {
    const { gateId } = await cellsFixture(); await tailorCells();
    const before = await describeApp();
    const command = { type: "editGate", gateId, vertices: [[103, 203], [204.5, 304.5]] };
    const preview = await request("preview", { command }); expect(preview.error).toBeUndefined();
    const population = (preview.result as any).populations.find((p: any) => p.name === "Cells");
    expect(population.counts.map((c: any) => c.n)).toEqual([2, 3]);
    expect(await cellsMembers()).toEqual({ "D1.fcs": [101, 102, 103, 104], "D2.fcs": [201, 202, 203] });
    expect((await describeApp()).revision).toBe(before.revision);
    expect((await apply(command, before.revision)).error).toBeUndefined();
    const after = await describeApp();
    expect(after.gates.find((g) => g.id === gateId)?.vertices).toEqual(command.vertices);
    expect((after.gates.find((g) => g.id === gateId) as any).editing).toMatchObject({ owner: { kind: "file" }, target: { kind: "file" } });
    expect(await cellsMembers()).toEqual({ "D1.fcs": [103, 104], "D2.fcs": [201, 202, 203] });
    const workspace = JSON.parse(((await request("workspace")).result as any).json);
    expect(workspace.gating.hierarchies.find((h: any) => h.id === workspace.gating.active_hierarchy_id).owner_sample_id).toBeUndefined();
    expect((await apply({ type: "undo" })).error).toBeUndefined();
    expect(await cellsMembers()).toEqual({ "D1.fcs": [101, 102, 103, 104], "D2.fcs": [201, 202, 203] });
    expect((await apply({ type: "redo" })).error).toBeUndefined();
    expect(await cellsMembers()).toEqual({ "D1.fcs": [103, 104], "D2.fcs": [201, 202, 203] });
    await view({ sampleId: after.samples[1].id }); await view({ sampleId: after.samples[0].id });
    expect((await describeApp()).gates.find((g) => g.id === gateId)?.vertices).toEqual(command.vertices);
  });

  it("rejects an old preview revision when the viewed file changes its edit owner", async () => {
    const { d, gateId } = await cellsFixture(); await tailorCells();
    const command = { type: "editGate", gateId, vertices: [[103, 203], [204.5, 304.5]] };
    const preview = await request("preview", { command });
    const revision = (preview.result as any).revision;
    await view({ sampleId: d.samples[1].id });
    const response = await apply(command, revision);
    expect(response.error?.code).toBe("conflict");
    expect(await cellsMembers()).toEqual({ "D1.fcs": [101, 102, 103, 104], "D2.fcs": [201, 202, 203] });
  });

  it("keeps a pending group target during preview, edits its existing copy once, and leaves the tree's geometry unchanged", async () => {
    const { d, gateId } = await cellsFixture();
    await pendingGroupTarget(d);
    const command = { type: "editGate", gateId, vertices: [[103, 203], [204.5, 304.5]] };
    const before = await describeApp();
    expect(before.gates[0].editing).toMatchObject({ owner: { kind: "tree" }, target: { kind: "group", name: "Group A" }, pending: true });
    const preview = await request("preview", { command }); expect(preview.error).toBeUndefined();
    expect((preview.result as any).populations.find((p: any) => p.name === "Cells").counts.map((c: any) => c.n)).toEqual([2, 4]);
    expect((await describeApp()).gates[0].editing).toEqual(before.gates[0].editing);
    expect((await describeApp()).revision).toBe(before.revision);
    expect((await apply(command, before.revision)).error).toBeUndefined();
    expect(await cellsMembers()).toEqual({ "D1.fcs": [103, 104], "D2.fcs": [201, 202, 203, 204] });
    expect((await describeApp()).gates[0].editing).toMatchObject({ owner: { kind: "group" }, target: { kind: "group" }, pending: false });
    const workspace = JSON.parse(((await request("workspace")).result as any).json);
    expect(workspace.gating.gates[gateId].vertices).toEqual([[100, 200], [203.5, 303.5]]);
    expect((await apply({ type: "undo" })).error).toBeUndefined();
    expect(await cellsMembers()).toEqual({ "D1.fcs": [101, 102, 103, 104], "D2.fcs": [201, 202, 203] });
  });

  it("edits the clicked file's solid version in a pool, then the tree when the other file follows it", async () => {
    const { d, gateId } = await cellsFixture(); await tailorCells();
    act(() => container.querySelector<HTMLButtonElement>(".gl-pool-toggle [aria-checked=false]")!.click()); await settle();
    const command = { type: "editGate", gateId, vertices: [[103, 203], [204.5, 304.5]] };
    const preview = await request("preview", { command }); expect(preview.error).toBeUndefined();
    expect((preview.result as any).populations.find((p: any) => p.name === "Cells").counts.map((c: any) => c.n)).toEqual([2, 3]);
    expect((await apply(command)).error).toBeUndefined();
    expect(await cellsMembers()).toEqual({ "D1.fcs": [103, 104], "D2.fcs": [201, 202, 203] });
    await view({ sampleId: d.samples[1].id });
    expect((await describeApp()).gates[0].editing).toMatchObject({ owner: { kind: "tree" }, target: { kind: "tree" } });
    expect((await apply(command)).error).toBeUndefined();
    expect(await cellsMembers()).toEqual({ "D1.fcs": [103, 104], "D2.fcs": [201, 202, 203, 204] });
  });
});

describe("agent view acknowledgements", () => {
  it("answers empty and repeated sample/axis requests without changing gating", async () => {
    const before = await describeApp();
    expect(await view({})).toEqual(before.view);
    const params = { sampleId: before.view.sampleId!, x: before.view.x!, y: before.view.y! };
    expect(await view(params)).toEqual(before.view);
    expect(await view(params)).toEqual(before.view);
    const after = await describeApp();
    expect(after.revision).toBe(before.revision);
    expect(after.gates).toEqual(before.gates);
    expect(after.populations).toEqual(before.populations);
  });

  it("returns the committed sample and axes, then answers the same request again", async () => {
    const before = await describeApp();
    const other = before.samples.find((s) => s.id !== before.view.sampleId)!;
    const params = { sampleId: other.id, x: "CD4", y: "FSC-A" };
    expect(await view(params)).toMatchObject(params);
    expect(await view(params)).toMatchObject(params);
    expect((await describeApp()).view).toMatchObject(params);
  });

  it.each([true, "data"] as const)("answers repeated fit=%s even when the axes and pan are unchanged", async (fit) => {
    const first = await view({ fit });
    expect(await view({ fit })).toEqual(first);
  });

  it("answers repeated explicit ranges after clearing an already clear pan", async () => {
    const params = { xRange: [50, 500], yRange: [50, 600] } satisfies AgentViewParams;
    expect((await view(params)).ranges).toEqual({ x: params.xRange, y: params.yRange });
    expect((await view(params)).ranges).toEqual({ x: params.xRange, y: params.yRange });
  });
});

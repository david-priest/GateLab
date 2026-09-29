// @vitest-environment jsdom
// A file whose copy of the tree was restructured (reachable only from a loaded workspace: the UI
// never unlocks a copy's structure). Where the file's own tree has no counterpart for a population,
// Save to SCE and Export populations to colData send that population as not evaluated for the file,
// NA with a note naming the file and the population, instead of gating the file with another tree.
// Public BCR-XL files served by a fake SCE host.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { GateLabHostProvider } from "./host/HostContext";
import { BCRXL_FILES, bcrxlAvailable, bcrxlHost, bcrxlSce, membershipBits } from "./host/bcrxlSceFixture";

const plotHarness: { props: Record<string, any> | null } = { props: null };
vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: (props: Record<string, any>) => { plotHarness.props = props; return <div data-testid="gating-plot" />; },
}));

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

async function settle(ms = 40): Promise<void> { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); }
const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button")];
const button = (label: string) => buttons().find((b) => b.textContent?.trim().startsWith(label))!;
const fileRow = (name: string) => [...container.querySelectorAll<HTMLElement>(".gl-sample-row")].find((r) => r.textContent?.includes(name))!;
async function view(name: string) { act(() => fileRow(name).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }))); await settle(); }
async function edit(mode: "tree" | "file") { act(() => container.querySelector<HTMLButtonElement>(`.population-tree-edit-${mode}`)!.click()); await settle(); }
async function mount(host: Parameters<typeof GateLabHostProvider>[0]["host"]) {
  await act(async () => {
    root.render(<GateLabHostProvider host={host}><App /></GateLabHostProvider>);
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  await settle(200);
}

describe.runIf(bcrxlAvailable())("populations a file's own tree lacks (public BCR-XL)", () => {
  it("are NA with a note in Save to SCE and in colData, never another tree's gating", async () => {
    const sce = bcrxlSce();
    const [, tailored] = BCRXL_FILES;

    // Tailor file 1 through the UI, then save with the tree live, to have a real workspace.
    const first = bcrxlHost(sce);
    await mount(first.host);
    await view(tailored);
    await edit("file");
    const bGate = plotHarness.props!.payload.gates.find((g: { name: string }) => g.name === "B cells: CD20+/CD3-low");
    const lo = Math.min(...bGate.vertices.map((v: number[]) => v[1]));
    act(() => plotHarness.props!.onGateEdit({
      gate_id: bGate.gate_id,
      vertices: bGate.vertices.map(([x, y]: number[]) => [x, y === lo ? 3.2 : y]),
    }));
    await settle();
    await edit("tree");
    act(() => button("Save to SCE").click());
    await settle(150);
    const saved = JSON.parse(first.record.writes.filter((w) => w.reason === "explicit").at(-1)!.workspaceJson);
    act(() => root.unmount());
    root = createRoot(container);

    // Restructure the file's copy as a hand-edited or imported workspace can: unlocked, IgM+ B cells
    // removed, and a population of its own added under B cells.
    const gating = saved.gating;
    const copyRef = gating.hierarchies.find((h: { owner_sample_id?: string }) => h.owner_sample_id);
    const copy = gating.stored_hierarchies.find((h: { id: string }) => h.id === copyRef.id);
    expect(copy).toBeTruthy();
    copyRef.structure_locked = false;
    copy.structure_locked = false;
    const idOf = (name: string) => Object.keys(copy.populations).find((id) => copy.populations[id].name === name)!;
    const bCells = idOf("B cells");
    const igmPos = idOf("IgM+ B cells");
    delete copy.populations[igmPos];
    copy.gates["copy-cd20-high"] = {
      gate_id: "copy-cd20-high", name: "CD20 high", gate_type: "rectangle", x_channel: "IgM", y_channel: "CD20",
      vertices: [[-3, 4.5], [8, 8]], color: "#377eb8", label_offset: null,
    };
    copy.gate_order.push("copy-cd20-high");
    copy.populations["copy-only"] = {
      population_id: "copy-only", name: "CD20-high B cells", parent_id: bCells, children: [],
      gate_refs: [{ gate_id: "copy-cd20-high", include: true }], gate_logic: "and", event_count: null, percent_of_parent: null,
    };
    copy.populations[bCells].children = [...copy.populations[bCells].children.filter((id: string) => id !== igmPos), "copy-only"];

    const second = bcrxlHost(sce, { sourceFormat: "gatelab-workspace", workspaceJson: JSON.stringify(saved) });
    await mount(second.host);
    expect(container.textContent).toContain("IgM+ B cells");

    act(() => button("Save to SCE").click());
    await settle(150);
    const memberships = second.record.writes.filter((w) => w.reason === "explicit").at(-1)!.memberships!;
    const mainId = memberships.hierarchies.find((h) => h.active)!.id;
    const igm = memberships.populations.find((p) => p.hierarchyId === mainId && p.populationName === "IgM+ B cells")!;
    expect(igm.sampleMasks.map((m) => m.notEvaluated === undefined)).toEqual([true, false, true]);
    expect(igm.sampleMasks[1].membershipBitsBase64).toBe("");
    const copyOnly = memberships.populations.find((p) => p.populationName === "CD20-high B cells")!;
    expect(copyOnly.sampleMasks.map((m) => m.notEvaluated === undefined)).toEqual([false, true, false]);
    // The note reaches the user: the file and the population, in the save message.
    expect(container.textContent).toMatch(/NA where not evaluated: 'IgM\+ B cells' of 'Main' was not evaluated for PBMC8_30min_patient1_BCR-XL/);

    // colData from the tree: file 1's IgM+ B cells column is NA, the others are gated by the tree.
    act(() => button("Export populations to colData").click());
    await settle();
    act(() => [...container.querySelectorAll<HTMLButtonElement>(".gl-sce-coldata-toolbar button")].find((b) => b.textContent === "None")!.click());
    const igmBox = [...container.querySelectorAll<HTMLLabelElement>(".gl-sce-coldata-pop")].find((l) => l.textContent === "IgM+ B cells")!.querySelector("input")!;
    act(() => igmBox.click());
    act(() => [...container.querySelectorAll<HTMLButtonElement>(".gl-sce-coldata-modal button")].find((b) => /^Export/.test(b.textContent ?? ""))!.click());
    await settle(150);
    expect(second.record.columnWrites).toHaveLength(1);
    const column = second.record.columnWrites[0][0];
    expect(column.populationName).toBe("IgM+ B cells");
    expect(column.sampleMasks[1]).toMatchObject({ sampleId: "sample-1", eventCount: 2838, membershipBitsBase64: "" });
    expect(column.sampleMasks[1].notEvaluated).toMatch(/PBMC8_30min_patient1_BCR-XL/);
    // Files 0 and 2 under the tree: the public example's IgM+ B cells for patient1_Reference, 125.
    const bits = membershipBits(column.sampleMasks[0].membershipBitsBase64, column.sampleMasks[0].eventCount);
    expect(bits.reduce((a, b) => a + b, 0)).toBe(125);
    expect(container.textContent).toMatch(/NA where not evaluated: 'IgM\+ B cells' of 'Main'/);

    // The Statistics tab shows no count for it either, and says why.
    act(() => buttons().find((b) => b.getAttribute("role") === "tab" && b.textContent === "Statistics")!.click());
    await settle();
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Statistics file"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "__all__");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    const header = [...container.querySelectorAll(".gl-stats-table thead th")].map((th) => th.textContent!.trim());
    const igmRow = [...container.querySelectorAll(".gl-stats-table tbody tr")]
      .map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent!.trim()))
      .find((cells) => cells[0] === "IgM+ B cells")!;
    expect(igmRow[header.indexOf(tailored)]).toBe("—");
    expect(igmRow[header.indexOf(BCRXL_FILES[0])]).not.toBe("—");
    expect(container.querySelector(".gl-stats-note")?.textContent).toMatch(/'IgM\+ B cells' of 'Main' was not evaluated for PBMC8_30min_patient1_BCR-XL/);
  }, 30_000);
});

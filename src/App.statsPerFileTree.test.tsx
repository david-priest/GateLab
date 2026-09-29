// @vitest-environment jsdom
// The Statistics tab, on screen and in its CSV, reports every file under the tree it is gated
// under: a tailored file's counts come from its own copy of the tree even while the tree itself is
// live, exactly as its memberships reach R. Public BCR-XL files served by a fake SCE host.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { GateLabHostProvider } from "./host/HostContext";
import { BCRXL_FILES, bcrxlAvailable, bcrxlHost, bcrxlSce } from "./host/bcrxlSceFixture";

const plotHarness: { props: Record<string, any> | null } = { props: null };
vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: (props: Record<string, any>) => { plotHarness.props = props; return <div data-testid="gating-plot" />; },
}));

let root: Root;
let container: HTMLDivElement;
let uuid = 0;
let clipboard: string[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  clipboard = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { clipboard.push(text); } },
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

async function settle(ms = 40): Promise<void> { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); }
const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button")];
const fileRow = (name: string) => [...container.querySelectorAll<HTMLElement>(".gl-sample-row")].find((r) => r.textContent?.includes(name))!;
async function view(name: string) { act(() => fileRow(name).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }))); await settle(); }
async function edit(mode: "tree" | "file") { act(() => container.querySelector<HTMLButtonElement>(`.population-tree-edit-${mode}`)!.click()); await settle(); }
async function tab(label: string) { act(() => buttons().find((b) => b.getAttribute("role") === "tab" && b.textContent === label)!.click()); await settle(); }
/** The count the Gating tab's population tree shows for `name`, for the viewed file under the edit target. */
const treeCount = (name: string) => {
  const row = [...container.querySelectorAll<HTMLElement>(".pop-row")].find((r) => r.querySelector(".pop-row-name")?.textContent?.trim() === name)!;
  return Number(row.querySelector(".pop-row-count")!.textContent!.replace(/[^0-9]/g, ""));
};
function tailor(gateName: string, change: (vertices: [number, number][]) => [number, number][]) {
  const gate = plotHarness.props!.payload.gates.find((g: { name: string }) => g.name === gateName);
  act(() => plotHarness.props!.onGateEdit({ gate_id: gate.gate_id, vertices: change(gate.vertices) }));
}
async function statisticsFile(value: string) {
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Statistics file"]')!;
  const option = [...select.options].find((o) => o.value === value || o.textContent?.startsWith(value))!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, option.value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}
/** The Statistics table as text: header cells, then each row's cells, the population name first. */
const statsTable = () => {
  const table = container.querySelector<HTMLTableElement>(".gl-stats-table")!;
  const header = [...table.querySelectorAll("thead th")].map((th) => th.textContent!.trim());
  const rows = [...table.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent!.trim()));
  return { header, rows };
};
const cell = (table: { header: string[]; rows: string[][] }, population: string, column: string) =>
  Number(table.rows.find((r) => r[0] === population)![table.header.indexOf(column)].replace(/[^0-9]/g, ""));
/** A strict RFC 4180 reader is overkill here: none of these names holds a comma or a quote. */
const csvRows = (text: string) => text.split("\r\n").filter(Boolean).map((line) => line.split(","));

describe.runIf(bcrxlAvailable())("Statistics under each file's own tree (public BCR-XL)", () => {
  it("reports a tailored file from its own copy while the tree is live, on screen and in the CSV", async () => {
    const { host } = bcrxlHost(bcrxlSce());
    await act(async () => {
      root.render(<GateLabHostProvider host={host}><App /></GateLabHostProvider>);
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    await settle(200);
    const [reference, tailored] = BCRXL_FILES;

    // Under the tree: the public example's own counts (manifest-and-validation.json).
    await view(tailored);
    expect(treeCount("B cells")).toBe(130);
    expect(treeCount("T cells")).toBe(1995);

    // Tailor the viewed file: B cells need more CD20, T cells more CD3.
    await edit("file");
    tailor("B cells: CD20+/CD3-low", (v) => {
      const lo = Math.min(...v.map((p) => p[1]));
      return v.map(([x, y]) => [x, y === lo ? 3.2 : y] as [number, number]);
    });
    tailor("T cells: CD3+/CD20-low", (v) => {
      const lo = Math.min(...v.map((p) => p[0]));
      return v.map(([x, y]) => [x === lo ? 2.1 : x, y] as [number, number]);
    });
    await settle();
    expect(fileRow(tailored).querySelector(".gl-sample-tailored")).not.toBeNull();
    // Its own copy's counts, as the independent evaluator of the host review measured them.
    const own = { "B cells": treeCount("B cells"), "T cells": treeCount("T cells") };
    expect(own).toEqual({ "B cells": 120, "T cells": 1685 });

    // The tree live again: the Gating tab shows the viewed file under its own tree, as Statistics
    // does (#349's 9bcf408; until then it showed the edit target's tree, 130).
    await edit("tree");
    expect(treeCount("B cells")).toBe(own["B cells"]);
    await view(reference);
    const referenceUnderTree = { "B cells": treeCount("B cells"), "T cells": treeCount("T cells") };

    await tab("Statistics");
    await statisticsFile("__all__");
    const count = [...container.querySelectorAll<HTMLInputElement>('input[name="cmp-metric"]')].find((i) => i.closest("label")?.textContent?.trim() === "Count")!;
    act(() => count.click());
    await settle();
    const compare = statsTable();
    for (const population of ["B cells", "T cells"] as const) {
      expect(cell(compare, population, tailored)).toBe(own[population]);
      expect(cell(compare, population, reference)).toBe(referenceUnderTree[population]);
    }

    act(() => buttons().find((b) => b.textContent === "Copy CSV")!.click());
    await settle();
    const csv = csvRows(clipboard.at(-1)!);
    const column = csv[0].indexOf(tailored);
    expect(Number(csv.find((r) => r[0] === "B cells")![column])).toBe(120);
    expect(Number(csv.find((r) => r[0] === "T cells")![column])).toBe(1685);

    // The single-file view of the tailored file, while the tree is still live.
    await statisticsFile(tailored);
    const single = statsTable();
    expect(cell(single, "B cells", "Count")).toBe(120);
    expect(cell(single, "T cells", "Count")).toBe(1685);
  }, 30_000);
});

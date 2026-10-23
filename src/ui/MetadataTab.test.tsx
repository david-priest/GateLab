// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sample } from "../engine/sample";
import { MetadataTab } from "./MetadataTab";

let root: Root;
let host: HTMLDivElement;

const sampleOf = () => ({
  fcs: { nEvents: 1000 },
  channels: [{ key: "FSC-A" }],
  instrument: "flow",
}) as unknown as Sample;
const files = [
  { id: "f1", name: "D1_treated.fcs", sample: sampleOf() },
  { id: "f2", name: "D2_control.fcs", sample: sampleOf() },
  { id: "f3", name: "D3_control.fcs", sample: sampleOf() },
];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function render(groups: { id: string; name: string }[] = [], fileGroups: Record<string, string> = {}) {
  act(() => root.render(
    <MetadataTab
      samples={files}
      metadata={{}}
      columns={[{ name: "condition" }]}
      onSetCell={vi.fn()}
      onAddColumn={vi.fn()}
      onRenameColumn={vi.fn()}
      onDeleteColumn={vi.fn()}
      onImport={vi.fn()}
      populationRows={[]}
      populationMetadata={{}}
      populationColumns={[]}
      onSetPopCell={vi.fn()}
      onAddPopColumn={vi.fn()}
      onRenamePopColumn={vi.fn()}
      onDeletePopColumn={vi.fn()}
      groups={groups}
      fileGroups={fileGroups}
    />,
  ));
}
const sampleTable = () => host.querySelector<HTMLTableElement>(".gl-meta-table")!;
const headers = () => [...sampleTable().querySelectorAll("thead th")].map((th) => th.querySelector("input")?.value ?? th.textContent);

describe("MetadataTab", () => {
  it("shows the file groups as a read-only Group column beside the filename", () => {
    render([{ id: "g1", name: "B1" }, { id: "g2", name: "B2" }], { f1: "g1", f3: "g2" });
    expect(headers().slice(0, 2)).toEqual(["Filename (read-only)", "Group"]);
    const groupCells = [...sampleTable().querySelectorAll("tbody tr")].map((row) => row.children[1]);
    expect(groupCells.map((cell) => cell.textContent)).toEqual(["B1", "", "B2"]);
    expect(groupCells.every((cell) => cell.querySelector("input") === null)).toBe(true);
  });

  it("has no Group column in a workspace without groups", () => {
    render();
    expect(headers()).not.toContain("Group");
  });

  it("gives the sample_id column more room than the other fields", () => {
    render();
    const inputs = [...sampleTable().querySelectorAll<HTMLInputElement>("tbody tr:first-child input")];
    expect(inputs.map((input) => input.classList.contains("is-wide"))).toEqual([true, false]);
    const header = [...sampleTable().querySelectorAll<HTMLInputElement>("thead input")];
    expect(header.map((input) => [input.value, input.classList.contains("is-wide")])).toEqual([["sample_id", true], ["condition", false]]);
  });

  it("hides both tables' explanations with one × and brings them back with the one ?", () => {
    render();
    const sampleHint = "Sample ID (sample_id) is editable";
    const populationHint = "Annotate each gated population";
    expect(host.textContent).toContain(sampleHint);
    expect(host.textContent).toContain(populationHint);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Hide this explanation"]')!.click());
    expect(host.textContent).not.toContain(sampleHint);
    expect(host.textContent).not.toContain(populationHint);
    const shows = host.querySelectorAll<HTMLButtonElement>('button[aria-label="Show the explanation"]');
    expect(shows).toHaveLength(1);
    act(() => shows[0].click());
    expect(host.textContent).toContain(sampleHint);
    expect(host.textContent).toContain(populationHint);
  });
});

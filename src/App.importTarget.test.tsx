// @vitest-environment jsdom
//
// With more than one file loaded, an imported tree needs a target: every file, the selected
// files, or the viewed file alone. The tree lands on the group's template, never on a file's
// own copy, so "all files" really reaches every file.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => <div data-testid="gating-plot" />,
}));

function syntheticFcs(seed: number): FcsFile {
  const count = seed === 1 ? 3 : 4;
  return {
    version: "FCS3.1",
    nEvents: count,
    instrument: "flow",
    keywords: {},
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
    ],
    columns: [
      Float32Array.from({ length: count }, (_, index) => seed * 100 + index),
      Float32Array.from({ length: count }, (_, index) => seed * 100 + index + 10),
    ],
    spillover: null,
  };
}
vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: (buffer: ArrayBuffer) => syntheticFcs(new Uint8Array(buffer)[0]) };
});

import App from "./App";

const GATING_ML = `<?xml version="1.0"?>
<gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
  xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
  <gating:RectangleGate gating:id="g1" gating:name="Live">
    <gating:dimension gating:min="0" gating:max="100000"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
    <gating:dimension gating:min="0" gating:max="100000"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
  </gating:RectangleGate>
</gating:Gating-ML>`;

let root: Root;
let host: HTMLDivElement;
let uuid = 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  uuid = 0;
});

function fcsFile(name: string, seed: number): File {
  const bytes = Uint8Array.from([seed]);
  const file = new File([bytes], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
  return file;
}

/** The same gate, drawn elsewhere: the tree's structure with other coordinates. */
const GATING_ML_SHIFTED = GATING_ML.replace(/gating:min="0"/g, 'gating:min="20000"');
/** A second gate: a different structure from the tree's. */
const GATING_ML_TWO = GATING_ML.replace("</gating:Gating-ML>", `  <gating:RectangleGate gating:id="g2" gating:name="Singlets">
    <gating:dimension gating:min="0" gating:max="100000"><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
    <gating:dimension gating:min="0" gating:max="100000"><data-type:fcs-dimension data-type:name="SSC-A"/></gating:dimension>
  </gating:RectangleGate>
</gating:Gating-ML>`);

function xmlFile(doc = GATING_ML): File {
  const file = new File([doc], "gates.xml", { type: "text/xml" });
  Object.defineProperty(file, "text", { value: async () => doc });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode(doc).buffer });
  return file;
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)!;
const summary = () => host.querySelector(".population-tree-hierarchy-count")?.textContent;
const editTarget = () => host.querySelector<HTMLButtonElement>(".population-tree-edit-file")!.getAttribute("aria-pressed") === "true" ? "file" : "tree";
const fileRow = (name: string) => [...host.querySelectorAll<HTMLElement>(".gl-sample-row")].find((row) => row.textContent?.includes(name))!;
const popRows = () => [...host.querySelectorAll(".pop-row")].map((r) => r.textContent?.replace(/\s+/g, " ").slice(0, 30));

async function importXml(doc = GATING_ML): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input[accept=".xml,.wsp,.cef"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [xmlFile(doc)] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
  await settle();
}

describe("importing a tree with several files loaded", () => {
  it("asks which files the tree is for: the tree for all of them, or tailoring for the viewed file when the structure matches", async () => {
    act(() => root.render(<App />));
    const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')]
      .find((candidate) => !candidate.hasAttribute("webkitdirectory"))!;
    Object.defineProperty(input, "files", { configurable: true, value: [fcsFile("D1.fcs", 1), fcsFile("D2.fcs", 2)] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(summary()).toBe("2 files · all following");

    // Viewing a file leaves the tree live; the import lands on the tree.
    act(() => fileRow("D2.fcs").click());
    await settle();
    expect(editTarget()).toBe("tree");

    await importXml();
    expect(host.textContent).toContain("Which files should be gated with it?");
    const target = (value: string) => host.querySelector<HTMLInputElement>(`input[name="gatingml-import-target"][value="${value}"]`)!;
    expect(target("all").checked).toBe(true);
    // No tree yet: only the tree for everyone is on offer.
    expect(target("viewed").disabled).toBe(true);
    expect(host.textContent).toContain("There is no tree yet");
    act(() => button("Import").click());
    await settle();
    await settle();
    expect(host.textContent).toContain("applied to all 2 files");
    expect(summary()).toBe("2 files · all following");
    expect(popRows()).toHaveLength(2);
    expect(popRows()[0]).toContain("All Events");
    expect(popRows()[1]).toContain("Live");

    // The same structure with other coordinates, for the viewed file alone: its tailoring.
    await importXml(GATING_ML_SHIFTED);
    expect(host.textContent).toContain("Which files should be gated with it?");
    expect(target("viewed").disabled).toBe(false);
    act(() => target("viewed").click());
    act(() => button("Import").click());
    await settle();
    await settle();
    expect(host.textContent).toContain("as D2.fcs's tailoring");
    expect(summary()).toBe("2 files · 1 tailored");
    expect(fileRow("D2.fcs").querySelector(".gl-sample-tailored")?.textContent).toBe("1");
    expect(editTarget()).toBe("file");
    expect(popRows()).toHaveLength(2);

    // A different structure can only replace the tree, for every file; it never makes a second tree.
    await importXml(GATING_ML_TWO);
    expect(target("viewed").disabled).toBe(true);
    expect(target("selected").disabled).toBe(true);
    expect(host.textContent).toContain("Its structure differs from this workspace's tree");
    act(() => button("Import").click());
    await settle();
    await settle();
    // Merged into the one tree (the default with a tree present), and D2's tailoring went with the move.
    expect(host.textContent).toContain("applied to all 2 files");
    expect(summary()).toBe("2 files · all following");
    expect(popRows()).toHaveLength(4);
    expect(host.querySelector('select[aria-label="Hierarchy"]')).toBeNull();
  });
});

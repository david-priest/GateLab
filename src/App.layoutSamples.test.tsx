// @vitest-environment jsdom
//
// The files, and the checked files' ids, the app hands the Layout, Strategy and Illustration tabs are the same lists from one render to the next while
// nothing about them has changed: a new list on every render made the tab's figure and Plotting
// blocks lay themselves out again on each edit. Synthetic file sample_A.fcs; nothing here is a real experiment.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FcsFile } from "./engine/fcs";

const seen = vi.hoisted(() => ({ samples: [] as unknown[], checked: [] as unknown[] }));

vi.mock("./plots/GatingPlot", () => ({
  DEFAULT_GATING_FONT_SIZES: { tick: 9, axis: 12, title: 12, gate: 10 },
  GatingPlot: () => null,
}));
vi.mock("./plots/loadPlots", () => ({
  loadMiniPlots: () => ({ renderStrategyGrid: vi.fn(), renderMultiStrategyGrid: vi.fn(), renderIllustrationGrid: vi.fn(), renderMiniPlot: vi.fn() }),
  loadPlots: () => ({ CytofD3: {}, bus: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } }),
}));
// The Layout tab stands in as what it is handed, with one edit to make.
vi.mock("./ui/LayoutTab", () => ({
  LayoutTab: (props: { samples: unknown; workspace: unknown; onChange: (next: unknown) => void }) => {
    seen.samples.push(props.samples);
    seen.checked.push((props as { checkedSampleIds?: unknown }).checkedSampleIds);
    return <button type="button" onClick={() => props.onChange(structuredClone(props.workspace))}>Edit the sheet</button>;
  },
}));
// The Strategy and Illustration tabs stand in the same way, each with an edit to App's state
// that has nothing to do with the files.
vi.mock("./ui/StrategyTab", () => ({
  StrategyTab: (props: { files: unknown; checkedSampleIds: unknown; onDensityColorPowerChange: (value: number) => void }) => {
    seen.samples.push(props.files);
    seen.checked.push(props.checkedSampleIds);
    return <button type="button" onClick={() => props.onDensityColorPowerChange(seen.samples.length)}>Edit the sheet</button>;
  },
}));
vi.mock("./ui/IllustrationTab", () => ({
  IllustrationTab: (props: { samples: unknown; checkedSampleIds: unknown; onScaleChange: (key: string, range: [number, number] | null) => void }) => {
    seen.samples.push(props.samples);
    seen.checked.push(props.checkedSampleIds);
    return <button type="button" onClick={() => props.onScaleChange("FSC-A", [0, seen.samples.length])}>Edit the sheet</button>;
  },
}));
const syntheticFcs: FcsFile = {
  version: "FCS3.1", nEvents: 3, instrument: "flow", keywords: {},
  channels: [
    { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
    { index: 1, name: "SSC-A", marker: null, bits: 32, range: 262144 },
  ],
  columns: [Float32Array.from([10, 20, 30]), Float32Array.from([100, 200, 300])],
  spillover: null,
};
vi.mock("./engine/fcs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/fcs")>();
  return { ...actual, parseFcs: () => syntheticFcs };
});
vi.mock("./engine/workspaceHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engine/workspaceHistory")>();
  return {
    ...actual,
    listWorkspaceCheckpoints: vi.fn(async () => []),
    saveWorkspaceCheckpoint: vi.fn(async () => "saved"),
    requestPersistentWorkspaceHistory: vi.fn(async () => null),
  };
});

import App from "./App";

let root: Root;
let host: HTMLDivElement;
let uuid = 0;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  seen.samples = [];
  seen.checked = [];
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

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button:not(.gl-menu-trigger)")].find((b) => b.textContent?.trim() === label)!;

describe("the files handed to the Layout, Strategy and Illustration tabs", () => {
  it.each(["Layout", "Strategy", "Illustration"])("are the same list on the %s tab after an edit that changes nothing about them", async (tab) => {
    act(() => root.render(<App />));
    const input = [...host.querySelectorAll<HTMLInputElement>('input[type="file"][accept=".fcs"]')].find((i) => !i.hasAttribute("webkitdirectory"))!;
    const bytes = Uint8Array.from([1]);
    const file = new File([bytes], "sample_A.fcs");
    Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer.slice(0) });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    for (let i = 0; i < 3; i++) await settle();

    await act(async () => { button(tab).click(); });
    for (let i = 0; i < 3; i++) await settle();
    expect(seen.samples.length).toBeGreaterThan(0);
    const before = seen.samples.at(-1);
    const checkedBefore = seen.checked.at(-1);
    const renders = seen.samples.length;
    await act(async () => { button("Edit the sheet").click(); });
    await settle();
    // The edit rendered the tab again, with the lists it had.
    expect(seen.samples.length).toBeGreaterThan(renders);
    expect(seen.samples.at(-1)).toBe(before);
    expect(seen.checked.at(-1)).toBe(checkedBefore);
    expect((before as { id: string; name: string }[]).map((entry) => entry.name)).toEqual(["sample_A.fcs"]);
    expect((checkedBefore as string[]).length).toBe(1);
  });
});

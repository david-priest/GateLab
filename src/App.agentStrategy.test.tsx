// @vitest-environment jsdom
// The mounted App's adapter and the real handler opening the Strategy tab for an agent: the tab
// must show the populations asked for, whether it opens with them or is open already, without a
// single action reaching the reducer, and must not take the request again when it remounts.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHandler } from "./agent/handler";
import type { AgentApplied, AgentDescribe, AgentRenderedSvg, AgentResponse, AgentView, AgentViewParams } from "./agent/protocol";
import type { FcsFile } from "./engine/fcs";

const agent = vi.hoisted(() => ({ handler: null as AgentHandler | null }));
const reducer = vi.hoisted(() => ({ actions: [] as string[] }));
const plots = vi.hoisted(() => ({ renderStrategyGrid: vi.fn(), renderMultiStrategyGrid: vi.fn() }));
vi.mock("./agent/agentLink", async (original) => ({
  ...await original<typeof import("./agent/agentLink")>(),
  AgentLink: class {
    constructor(options: { handler: AgentHandler }) { agent.handler = options.handler; }
    notifyChanged() {}
    disconnect() {}
    relayHttpUrl(path: string) { return `http://127.0.0.1:48123${path}?token=t`; }
  },
}));
// Every action the App's reducer is handed, so "no dispatch" is observed rather than inferred.
vi.mock("./store", async (original) => {
  const store = await original<typeof import("./store")>();
  return { ...store, coreReducer: (state: Parameters<typeof store.coreReducer>[0], action: Parameters<typeof store.coreReducer>[1]) => { reducer.actions.push(action.type); return store.coreReducer(state, action); } };
});
vi.mock("./plots/loadPlots", async (original) => ({
  ...await original<typeof import("./plots/loadPlots")>(),
  loadMiniPlots: () => plots,
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

let root: Root;
let container: HTMLDivElement;
let uuid = 0;
const settle = async (ms = 20) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
const request = async <T,>(method: "describe" | "apply" | "view" | "render", params: unknown): Promise<AgentResponse & { result?: T }> => {
  let response: AgentResponse | undefined;
  // Not awaited inside act: React must be free to commit what the request waits for.
  act(() => { void agent.handler!.handle({ kind: "request", id: method, method, params }).then((r) => { response = r; }); });
  for (let i = 0; i < 8 && !response; i++) await settle();
  expect(response, `${method} must answer`).toBeDefined();
  return response as AgentResponse & { result?: T };
};
const describeApp = async () => (await request<AgentDescribe>("describe", {})).result!;
/**
 * A view request on React's own scheduler, outside act(): act() renders queued updates before the
 * request's continuation runs, which a browser does not, so only this shows a reply read one
 * commit too early.
 */
const view = async (params: AgentViewParams) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  try {
    const response = await Promise.race([
      agent.handler!.handle({ kind: "request", id: "view", method: "view", params }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("view did not answer")), 2000)),
    ]);
    expect(response.error).toBeUndefined();
    return response.result as AgentView;
  } finally {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  }
};

/** The layout controls as a tab opened for the first time holds them, which every reply reports. */
const TAB_DEFAULTS = { layout: "tree", columns: 4, showArrows: true, arrowWidth: 1.5, arrowAnchor: "label" };
const tab = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((el) => el.textContent === label)!;
const radio = (label: string) => [...container.querySelectorAll<HTMLLabelElement>("label.gl-check")].find((el) => el.textContent === label)!.querySelector("input")!;
const picked = () => [...container.querySelectorAll<HTMLLabelElement>(".gl-strategy-pops label[title]")].filter((el) => el.querySelector("input")!.checked).map((el) => el.title);

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
  reducer.actions.length = 0; plots.renderStrategyGrid.mockReset(); plots.renderMultiStrategyGrid.mockReset();
});

describe("an agent opening the Strategy tab", () => {
  it("shows the requested populations, open or not, with no action reaching the reducer", async () => {
    const start = await describeApp();
    const range = async (name: string, parentId: string, x: string, low: number) => {
      const applied = await request<AgentApplied>("apply", {
        command: { type: "createRange", name, parentId, x, y: x === "CD4" ? "FSC-A" : "SSC-A", space: "raw", xBounds: [low, null], yBounds: [null, null] },
        rationale: "Synthetic threshold.",
      });
      expect(applied.error).toBeUndefined();
      return applied.result!.created.populationIds[0];
    };
    const parent = await range("CD4_positive", start.rootPopulationId!, "CD4", 302);
    const child = await range("CD4_high", parent, "FSC-A", 103);
    await settle();
    const before = await describeApp();
    expect(before.view.tab).toBe("gating");
    reducer.actions.length = 0;

    // The tab opens with two populations: the multi-population grid of both.
    const multi = await view({ strategy: { populationIds: [child, parent] } });
    expect(multi).toMatchObject({ tab: "strategy", strategy: { mode: "multi", populationIds: [child, parent], fullPath: false } });
    await settle();
    expect(tab("Strategy").getAttribute("aria-selected")).toBe("true");
    expect(radio("Multiple pops").checked).toBe(true);
    expect(picked().sort()).toEqual(["CD4_high", "CD4_positive"]);
    await settle(250);
    expect(plots.renderMultiStrategyGrid).toHaveBeenCalled();
    expect(plots.renderMultiStrategyGrid.mock.lastCall![1]).toMatchObject({ strategy_context_title: expect.stringContaining("2 populations") });

    // Open already: one population, its whole path from the root.
    const single = await view({ strategy: { populationIds: [child], fullPath: true } });
    expect(single.strategy).toEqual({ mode: "single", populationIds: [child], fullPath: true, ...TAB_DEFAULTS });
    await settle(250);
    expect(radio("Single").checked).toBe(true);
    expect(container.querySelector<HTMLSelectElement>(".gl-strategy-inspector select")!.value).toBe(child);
    expect(radio("Full path from root").checked).toBe(true);
    await settle(250);
    expect(plots.renderStrategyGrid).toHaveBeenCalled();

    // Nothing reached the reducer: no gate, no selection, the revision where it was.
    expect(reducer.actions).toEqual([]);
    const after = await describeApp();
    expect(after.revision).toBe(before.revision);
    expect(after.populations).toEqual(before.populations);
    expect(after.gates).toEqual(before.gates);
    expect(after.view.populationId).toBe(before.view.populationId);

    // Taken once: the user's own change survives leaving the tab and coming back.
    act(() => { radio("Multiple pops").click(); });
    act(() => { tab("Gating").click(); });
    await settle();
    act(() => { tab("Strategy").click(); });
    await settle();
    expect(radio("Multiple pops").checked).toBe(true);
    expect(picked().sort()).toEqual(["CD4_high", "CD4_positive"]);
    expect((await describeApp()).view.strategy).toMatchObject({ mode: "multi", populationIds: [child, parent] });

    // Opening with one population: the tab's follow-the-active-population on mount does not replace it.
    act(() => { tab("Gating").click(); });
    await settle();
    reducer.actions.length = 0;
    expect((await view({ strategy: { populationIds: [parent], fullPath: false } })).strategy).toEqual({ mode: "single", populationIds: [parent], fullPath: false, ...TAB_DEFAULTS });
    await settle(250);
    expect(container.querySelector<HTMLSelectElement>(".gl-strategy-inspector select")!.value).toBe(parent);
    expect((await describeApp()).view.strategy).toEqual({ mode: "single", populationIds: [parent], fullPath: false, ...TAB_DEFAULTS });
    expect(after.view.populationId).not.toBe(parent);
    expect(reducer.actions).toEqual([]);
  });

  it("sets the layout controls as the user would, and posts the tab's SVG export to the relay", async () => {
    const start = await describeApp();
    const range = async (name: string, parentId: string, x: string, low: number) => {
      const applied = await request<AgentApplied>("apply", {
        command: { type: "createRange", name, parentId, x, y: x === "CD4" ? "FSC-A" : "SSC-A", space: "raw", xBounds: [low, null], yBounds: [null, null] },
        rationale: "Synthetic threshold.",
      });
      return applied.result!.created.populationIds[0];
    };
    const parent = await range("CD4_positive", start.rootPopulationId!, "CD4", 302);
    const child = await range("CD4_high", parent, "FSC-A", 103);
    await settle();
    reducer.actions.length = 0;
    // The renderer is a stand-in: it leaves one panel and an arrow overlay where the real one and
    // drawStrategyArrows would (jsdom lays nothing out, so the real arrows cannot be routed here).
    plots.renderMultiStrategyGrid.mockImplementation((id: string) => {
      document.getElementById(id)!.innerHTML = '<div id="strategy-grid-container-grid"><div class="mini-plot-cell"><svg width="200" height="200"><text>CD4</text></svg></div>'
        + '<svg class="gl-strategy-arrows"><path d="M0 0L10 10"/></svg></div>';
    });

    const controls = { layout: "flow", columns: 1, showArrows: true, arrowWidth: 2.5, arrowAnchor: "gate" } as const;
    const shown = await view({ strategy: { populationIds: [parent, child], ...controls } });
    expect(shown.strategy).toEqual({ mode: "multi", populationIds: [parent, child], fullPath: false, ...controls });
    await settle(250);
    const field = (label: string) => [...container.querySelectorAll<HTMLLabelElement>("label.gl-field-inline")].find((el) => el.textContent!.startsWith(label))!.querySelector<HTMLInputElement | HTMLSelectElement>("input, select")!;
    expect(field("Layout").value).toBe("flow");
    expect(field("Columns").value).toBe("1");
    expect(radio("Arrows").checked).toBe(true);
    expect(field("Arrow width").value).toBe("2.5");
    expect(field("Arrows from").value).toBe("gate");
    // Wrapped into one column: every panel in column 0, one row each, with gutters for the arrows.
    const payload = plots.renderMultiStrategyGrid.mock.lastCall![1] as { nodes: { row: number; col: number }[]; grid_gap?: number };
    expect(payload.nodes.map((node) => node.col)).toEqual(payload.nodes.map(() => 0));
    expect(payload.nodes.length).toBeGreaterThan(1);
    expect(payload.grid_gap).toBeGreaterThan(0);

    // The SVG: composed as the Export section's SVG button composes it, posted to the slot named.
    const posted: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: Blob }) => { posted.push({ url, body: await init.body.text() }); return new Response("{}", { status: 200 }); });
    const rendered = await request<AgentRenderedSvg>("render", { format: "svg", dpi: 150, upload: "/save/slot-1" });
    expect(rendered.error).toBeUndefined();
    expect(rendered.result).toMatchObject({ format: "svg", dpi: 150, view: { tab: "strategy" } });
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe("http://127.0.0.1:48123/save/slot-1?token=t");
    expect(posted[0].body.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(posted[0].body).toContain("strategy-arrows");
    expect(posted[0].body).toContain("M0 0L10 10");
    // The tab's own DPI when the agent names none.
    expect((await request<AgentRenderedSvg>("render", { format: "svg", upload: "/save/slot-2" })).result!.dpi).toBe(300);
    expect(reducer.actions).toEqual([]);

    // Off the Strategy tab there is no grid to write.
    await view({ tab: "gating" });
    expect((await request("render", { format: "svg", upload: "/save/slot-3" })).error?.message).toContain("open the Strategy tab first");
    expect(posted).toHaveLength(2);
  });

  it("refuses a population the tree does not hold, leaving the tab where it was", async () => {
    reducer.actions.length = 0;
    const response = await request("view", { strategy: { populationIds: ["P404"] } });
    expect(response.error).toMatchObject({ code: "refused", message: "Unknown population “P404”." });
    expect(tab("Gating").getAttribute("aria-selected")).toBe("true");
    expect(reducer.actions).toEqual([]);
  });
});

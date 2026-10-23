// @vitest-environment jsdom
// Exercise the mounted App's adapter and the real protocol handler: a mock adapter whose
// settled() always resolves cannot detect a request waiting for a React commit that never comes.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHandler } from "./agent/handler";
import type { AgentDescribe, AgentResponse, AgentView, AgentViewParams } from "./agent/protocol";
import type { FcsFile } from "./engine/fcs";

const agent = vi.hoisted(() => ({ handler: null as AgentHandler | null }));
vi.mock("./agent/agentLink", async (original) => ({
  ...await original<typeof import("./agent/agentLink")>(),
  AgentLink: class {
    constructor(options: { handler: AgentHandler }) { agent.handler = options.handler; }
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

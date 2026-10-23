// @vitest-environment jsdom
// A strategy proposal from the host, through the mounted App: shown for review with its counts on
// a copy, applied as one undo step when the user accepts it, dropped when they reject it, refused
// with the reason when it does not replay, and previewed again when the gating moved under the
// review. R hears each outcome through the channel.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHandler } from "./agent/handler";
import type { AgentApplied, AgentDescribe } from "./agent/protocol";
import type { FcsFile } from "./engine/fcs";
import type { HostProposalChannel, HostProposalResult } from "./proposals/hostProposals";

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
// D1: FSC-A 101–104, SSC-A 201–204. D2: FSC-A 201–204, SSC-A 301–304.
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
let listener: ((message: unknown) => void) | null = null;
let replies: HostProposalResult[] = [];
const channel: HostProposalChannel = {
  listen: (onMessage) => { listener = onMessage; return () => { listener = null; }; },
  reply: (result) => { replies.push(result); },
};
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
const request = async <T,>(method: "describe" | "apply", params: unknown = {}) => {
  const response = await agent.handler!.handle({ kind: "request", id: method, method, params });
  if (response.error) throw new Error(response.error.message);
  return response.result as T;
};
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Strategy proposal"]');
const button = (label: string) => [...dialog()!.querySelectorAll("button")].find((b) => b.textContent === label)!;
const send = async (message: unknown) => { act(() => listener!(message)); await settle(); };
const click = async (label: string) => { await act(async () => { button(label).click(); }); await settle(); };

const proposal = (proposalId: string, overrides: Record<string, unknown> = {}) => ({
  contractVersion: 1, proposalId, source: "host", by: "GateLabR", rationale: "Sent from R.",
  steps: [
    { key: "cells", command: { type: "createGate", shape: "rectangle", name: "Cells", parentId: "@root", x: "FSC-A", y: "SSC-A", space: "raw", vertices: [[100, 150], [300, 350]] } },
    { key: "small", command: { type: "createGate", shape: "polygon", name: "Small", parentId: "@cells.population", x: "FSC-A", y: "SSC-A", space: "raw", vertices: [[100, 150], [150, 150], [150, 250], [100, 250]] } },
    { key: "rest", command: { type: "definePopulation", name: "Not small", parentId: "@cells.population", gates: [{ gateId: "@small.gate", include: false }] } },
  ],
  targets: { CD4_positive: "@small.population", CD4_negative: "@rest.population" },
  ...overrides,
});

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<App hostProposals={channel} />));
  expect(listener, "proposals wait until there is data to count them on").toBeNull();
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
  expect((await request<AgentDescribe>("describe")).samples).toHaveLength(2);
  expect(listener).not.toBeNull();
});
afterEach(() => {
  act(() => root.unmount()); container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); agent.handler = null; uuid = 0; listener = null; replies = [];
});

describe("strategy proposals from the host", () => {
  it("shows the proposal's counts for review, changes nothing until it is applied, then applies it as one undo step", async () => {
    await send(proposal("p1"));
    expect(dialog()).not.toBeNull();
    expect(replies).toEqual([{ proposalId: "p1", status: "review", steps: 3, sampleIds: expect.any(Array) }]);
    expect((replies[0] as { sampleIds: string[] }).sampleIds).toHaveLength(2);
    expect(dialog()!.textContent).toContain("host");
    expect(dialog()!.textContent).toContain("Sent from R.");
    const rows = [...dialog()!.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
    expect(rows).toEqual([
      ["Cells", "8", "100.0%", ""],
      ["Small", "4", "50.0%", "CD4_positive"],
      ["Not small", "4", "50.0%", "CD4_negative"],
    ]);
    expect((await request<AgentDescribe>("describe")).gates).toEqual([]);

    await click("Apply proposal");
    expect(dialog()).toBeNull();
    const described = await request<AgentDescribe>("describe");
    expect(described.gates.map((g) => [g.name, g.provenance])).toEqual([
      ["Cells", expect.objectContaining({ by: "GateLabR", rationale: "Sent from R.", source: "host" })],
      ["Small", expect.objectContaining({ source: "host" })],
    ]);
    const accepted = replies[1] as Extract<HostProposalResult, { status: "accepted" }>;
    expect(accepted).toMatchObject({ proposalId: "p1", status: "accepted", revision: described.revision });
    expect(accepted.createdGateIds).toHaveLength(2);
    const byId = Object.fromEntries(described.populations.map((p) => [p.id, p]));
    expect(byId[accepted.targets.CD4_positive]).toMatchObject({ name: "Small", pooled: { n: 4 } });
    expect(byId[accepted.targets.CD4_negative]).toMatchObject({ name: "Not small", pooled: { n: 4 } });
    expect(byId[accepted.aliases["@cells.population"]]?.name).toBe("Cells");

    const undone = await request<AgentApplied>("apply", { command: { type: "undo" }, rationale: "Taking the proposal back." });
    expect(undone.gates).toEqual([]);
    expect(undone.populations).toHaveLength(1);
  });

  it("drops a rejected proposal, and tells R", async () => {
    await send(proposal("p1"));
    await click("Reject");
    expect(dialog()).toBeNull();
    expect(replies.at(-1)).toEqual({ proposalId: "p1", status: "rejected" });
    expect((await request<AgentDescribe>("describe")).gates).toEqual([]);
  });

  it("refuses a proposal that does not replay, with the reason, and shows nothing", async () => {
    const steps = proposal("x").steps;
    await send(proposal("p1", { steps: [steps[0], { ...steps[1], command: { ...steps[1].command, parentId: "@missing.population" } }] }));
    await send(proposal("p2", { steps: Array.from({ length: 129 }, (_, i) => ({ ...steps[0], key: `g${i}` })) }));
    await send({ ...proposal("p3"), contractVersion: 9 });
    await send({ contractVersion: 1, steps });
    expect(dialog()).toBeNull();
    expect(replies).toEqual([
      { proposalId: "p1", status: "refused", message: "Unknown proposal reference @missing.population." },
      { proposalId: "p2", status: "refused", message: "A proposal needs at most 128 steps." },
      { proposalId: "p3", status: "refused", message: "Unsupported strategy proposal contract 9; expected 1." },
      { proposalId: null, status: "refused", message: "proposalId must be a string of 1 to 128 characters." },
    ]);
    expect((await request<AgentDescribe>("describe")).gates).toEqual([]);
  });

  it("replaces a proposal under review with a newer one", async () => {
    await send(proposal("p1"));
    await send(proposal("p2", { rationale: "A second fit." }));
    expect(replies.map((r) => [r.proposalId, r.status])).toEqual([["p1", "review"], ["p1", "superseded"], ["p2", "review"]]);
    expect(dialog()!.textContent).toContain("A second fit.");
  });

  it("previews again when the gating moved under the review, and applies on the second acceptance", async () => {
    await send(proposal("p1"));
    const root = (await request<AgentDescribe>("describe")).rootPopulationId;
    // Not awaited inside act: the apply waits for a React commit that act would hold back.
    let made = false;
    act(() => {
      void request<AgentApplied>("apply", {
        command: { type: "createGate", shape: "rectangle", name: "Meanwhile", parentId: root, x: "FSC-A", y: "SSC-A", space: "raw", vertices: [[0, 0], [1000, 1000]] },
        rationale: "Made while the proposal was open.",
      }).then(() => { made = true; });
    });
    for (let i = 0; i < 4 && !made; i++) await settle();
    expect(made).toBe(true);
    await click("Apply proposal");
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain("The gating changed after the proposal was previewed.");
    expect(replies.map((r) => r.status)).toEqual(["review"]);
    expect((await request<AgentDescribe>("describe")).gates.map((g) => g.name)).toEqual(["Meanwhile"]);

    await click("Apply proposal");
    expect(dialog()).toBeNull();
    expect(replies.map((r) => r.status)).toEqual(["review", "accepted"]);
    expect((await request<AgentDescribe>("describe")).gates.map((g) => g.name)).toEqual(["Meanwhile", "Cells", "Small"]);
  });
});

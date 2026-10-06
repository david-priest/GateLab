// The handler over a real Sample and the real reducer, with a stand-in for the app: every method,
// what a refusal looks like, and that a command applied by an agent is an ordinary gate with its
// provenance on it.
import { describe, expect, it } from "vitest";
import { Sample } from "../engine/sample";
import type { FcsFile } from "../engine/fcs";
import { coreReducer, initialCoreState, recomputeGating, type Action, type CoreState } from "../store";
import { createAgentHandler, valleysOf, type AgentAdapter, type AgentSampleView } from "./handler";
import type { AgentApplied, AgentDescribe, AgentDistribution, AgentMemberships, AgentPreview, AgentRequest, AgentResponse, AgentStats, AgentView } from "./protocol";

function flowSample(values: Record<string, number[]>): Sample {
  const names = Object.keys(values);
  const nEvents = values[names[0]].length;
  const fcs: FcsFile = {
    version: "FCS3.1", nEvents,
    channels: names.map((name, index) => ({ index, name, marker: name.startsWith("FL") ? "CD4" : null, bits: 32, range: 262144 })),
    keywords: {}, columns: names.map((name) => Float32Array.from(values[name])), spillover: null, instrument: "flow",
  };
  const sample = new Sample(fcs);
  // Scatter drawn linear whatever the app's default, so display units are the raw values below.
  for (let idx = 0; idx < sample.channels.length; idx++) if (sample.isScatterAxis(idx)) sample.setScatterScale(idx, "linear");
  return sample;
}

/** D1: FSC-A 0, 10, 20 … 190 (200 events); SSC-A the same reversed. D2: 100 events, FSC-A 0 … 99. */
function fixture() {
  const d1 = flowSample({ "FSC-A": Array.from({ length: 200 }, (_, i) => i * 10), "SSC-A": Array.from({ length: 200 }, (_, i) => (199 - i) * 10), "FL1-A": Array.from({ length: 200 }, (_, i) => i * 100) });
  const d2 = flowSample({ "FSC-A": Array.from({ length: 100 }, (_, i) => i), "SSC-A": Array.from({ length: 100 }, () => 500), "FL1-A": Array.from({ length: 100 }, (_, i) => 1000 + i) });
  let state: CoreState = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 200 });
  const view: AgentView = { populationId: state.root_population_id, sampleId: "D1", x: "FSC-A", y: "SSC-A", tab: "gating", ranges: { x: null, y: null } };
  const held: Record<string, [number, number]> = {};
  const entries: { id: string; name: string; sample: Sample; viewed: boolean; checked: boolean; metadata: Record<string, string> }[] = [
    { id: "D1", name: "D1.fcs", sample: d1, viewed: true, checked: true, metadata: { condition: "treated" } },
    { id: "D2", name: "D2.fcs", sample: d2, viewed: false, checked: true, metadata: { condition: "control" } },
  ];
  const adapter: AgentAdapter = {
    info: () => ({ app: "GateLab", version: "test", host: "browser", workspaceName: null }),
    state: () => state,
    samples: (): AgentSampleView[] => entries.map((entry) => ({
      ...entry, hierarchyId: state.active_hierarchy_id,
      gating: () => recomputeGating(entry.sample, state),
    })),
    dispatch: (action: Action) => { state = coreReducer(state, action); },
    settled: async () => {},
    view: () => ({ ...view, populationId: state.active_population_id ?? view.populationId, ranges: { x: view.x ? held[view.x] ?? null : null, y: view.y ? held[view.y] ?? null : null } }),
    setView: async (params) => { const { fit: _fit, xRange: _x, yRange: _y, ...rest } = params; Object.assign(view, rest); },
    setAxisRange: (channel, range) => { held[channel] = range; },
    render: async () => ({ png: "data:image/png;base64,AAAA", width: 10, height: 10 }),
    workspaceJson: () => JSON.stringify({ gating: { gate_order: state.gate_order } }),
    fit: () => { fits++; },
    clearPan: () => { pans++; },
    reload: () => { reloads++; },
  };
  let fits = 0, reloads = 0, pans = 0;
  const handler = createAgentHandler(adapter);
  handler.setWriter("test-agent");
  let n = 0;
  const call = async <T,>(method: AgentRequest["method"], params?: unknown): Promise<T> => {
    const response: AgentResponse = await handler.handle({ kind: "request", id: `r${++n}`, method, params });
    if (response.error) throw new Error(`${response.error.code}: ${response.error.message}`);
    return response.result as T;
  };
  const refusal = async (method: AgentRequest["method"], params?: unknown): Promise<AgentResponse["error"]> => {
    const response = await handler.handle({ kind: "request", id: `r${++n}`, method, params });
    return response.error;
  };
  return { call, refusal, handler, getState: () => state, d1, d2, fits: () => fits, reloads: () => reloads, pans: () => pans };
}

describe("the agent handler", () => {
  it("describes the loaded data: channels as drawn, samples, the root with its counts, the view", async () => {
    const { call } = fixture();
    const d = await call<AgentDescribe>("describe");
    expect(d.revision).toBe(1);
    expect(d.host.host).toBe("browser");
    // A fluorescence channel with a marker is keyed by the marker.
    expect(d.channels.map((c) => [c.key, c.kind])).toEqual([["FSC-A", "scatter"], ["SSC-A", "scatter"], ["CD4", "fluorescence"]]);
    expect(d.channels[2]).toMatchObject({ pnn: "FL1-A", marker: "CD4" });
    expect(d.samples).toEqual([
      { id: "D1", name: "D1.fcs", events: 200, viewed: true, checked: true, metadata: { condition: "treated" } },
      { id: "D2", name: "D2.fcs", events: 100, viewed: false, checked: true, metadata: { condition: "control" } },
    ]);
    expect(d.populations).toHaveLength(1);
    expect(d.populations[0]).toMatchObject({ id: d.rootPopulationId, parentId: null, depth: 0, pooled: { n: 300, parentN: 300, percentOfParent: 100, percentOfTotal: 100 } });
    expect(d.populations[0].counts).toEqual([{ sampleId: "D1", n: 200, parentN: 200, percentOfParent: 100 }, { sampleId: "D2", n: 100, parentN: 100, percentOfParent: 100 }]);
    expect(d.gates).toEqual([]);
    expect(d.view).toMatchObject({ x: "FSC-A", y: "SSC-A", sampleId: "D1" });
  });

  it("applies a range as an ordinary gate with the agent's provenance, and counts it per sample and pooled", async () => {
    const { call, getState } = fixture();
    const root = getState().root_population_id!;
    const applied = await call<AgentApplied>("apply", {
      command: { type: "createRange", name: "FSC high", parentId: root, x: "FSC-A", y: "SSC-A", space: "display", xBounds: [1000, null], yBounds: [null, null] },
      rationale: "FSC-A is bimodal with the valley at 1000.",
      expectedRevision: 1,
    });
    expect(applied.revision).toBe(2);
    expect(applied.created.gateIds).toHaveLength(1);
    expect(applied.created.populationIds).toHaveLength(1);
    const gate = applied.gates[0];
    expect(gate).toMatchObject({ name: "FSC high", type: "rectangle", x: "FSC-A", y: "SSC-A", space: "display", bounds: "closed" });
    // A null bound is the edge of the data over every loaded file, 2% of the span past the last
    // event: FSC-A ends at 1990 (D1), SSC-A spans 500 (D2) to 1990 (D1), so nothing is off the chart.
    expect(gate.vertices![0][0]).toBe(1000);
    expect(gate.vertices![1][0]).toBeCloseTo(1990 + 1990 * 0.02, 6);
    expect(gate.vertices![0][1]).toBeCloseTo(0 - 1990 * 0.02, 6);
    expect(gate.vertices![1][1]).toBeCloseTo(1990 + 1990 * 0.02, 6);
    expect(gate.provenance).toMatchObject({ by: "test-agent", rationale: "FSC-A is bimodal with the valley at 1000." });
    expect(typeof gate.provenance?.at).toBe("string");
    // The reducer holds the same gate, provenance included.
    expect(getState().gates[gate.id].provenance?.by).toBe("test-agent");
    // D1: FSC-A 1000 … 1990 → 100 events (the bound includes 1000); D2: none.
    const pop = applied.populations.find((p) => p.name === "FSC high")!;
    expect(pop.counts).toEqual([{ sampleId: "D1", n: 100, parentN: 200, percentOfParent: 50 }, { sampleId: "D2", n: 0, parentN: 100, percentOfParent: 0 }]);
    expect(pop.pooled).toEqual({ n: 100, parentN: 300, percentOfParent: 100 / 3, percentOfTotal: 100 / 3 });
    // Undo is a command too.
    const undone = await call<AgentApplied>("apply", { command: { type: "undo" }, rationale: "Taking it back." });
    expect(undone.gates).toEqual([]);
    expect(undone.revision).toBe(3);
  });

  it("previews a polygon without changing the state", async () => {
    const { call, getState } = fixture();
    const root = getState().root_population_id!;
    const before = getState();
    const preview = await call<AgentPreview>("preview", {
      command: { type: "createGate", shape: "polygon", name: "Triangle", parentId: root, x: "FSC-A", y: "SSC-A", space: "display", vertices: [[0, 0], [2000, 0], [0, 2000]] },
    });
    const triangle = preview.populations.find((p) => p.name === "Triangle")!;
    expect(triangle.isNew).toBe(true);
    // D1: FSC + SSC = 1990 for every event → all 200 inside; D2: FSC < 100, SSC 500 → all 100 inside.
    expect(triangle.pooled.n).toBe(300);
    expect(preview.gates.filter((g) => g.isNew)).toHaveLength(1);
    expect(getState()).toBe(before);
    expect((await call<AgentDescribe>("describe")).gates).toEqual([]);
  });

  it("refuses what it cannot do, with a reason, and reports a moved revision as a conflict", async () => {
    const { call, refusal, getState } = fixture();
    const root = getState().root_population_id!;
    const bad = (command: unknown) => refusal("apply", { command, rationale: "because" });
    expect((await bad({ type: "createRange", name: "x", parentId: "nope", x: "FSC-A", y: "SSC-A", space: "display", xBounds: [1, null], yBounds: [null, null] }))?.message).toContain("Unknown population");
    expect((await bad({ type: "createRange", name: "x", parentId: root, x: "FSC-A", y: "FSC-A", space: "display", xBounds: [1, null], yBounds: [null, null] }))?.message).toContain("two different channels");
    expect((await bad({ type: "createRange", name: "x", parentId: root, x: "FSC-A", y: "SSC-A", space: "display", xBounds: [null, null], yBounds: [null, null] }))?.message).toContain("at least one bound");
    expect((await bad({ type: "createGate", shape: "polygon", name: "x", parentId: root, x: "FSC-A", y: "SSC-A", space: "display", vertices: [[0, 0], [1, 1], [1, 0], [0, 1]] }))?.message).toContain("cross itself");
    expect((await bad({ type: "createGate", shape: "rectangle", name: "x", parentId: root, x: "FSC-A", y: "SSC-A", space: "raw", vertices: [[0, 0], [0, 5]] }))?.message).toContain("nonzero width");
    expect((await bad({ type: "createGate", shape: "polygon", name: "x", parentId: root, x: "FSC-A", y: "SSC-A", space: "other", vertices: [[0, 0], [1, 0], [0, 1]] }))?.message).toContain('"raw" or "display"');
    expect((await bad({ type: "undo" }))?.message).toContain("Nothing to undo");
    expect((await refusal("apply", { command: { type: "undo" } }))?.message).toContain("rationale");
    expect((await refusal("apply", { command: { type: "undo" }, rationale: "x", expectedRevision: 7 }))).toMatchObject({ code: "conflict", revision: 1 });
    expect((await refusal("nonsense" as AgentRequest["method"]))?.code).toBe("unknown-method");
    expect((await call<AgentDescribe>("describe")).gates).toEqual([]);
  });

  it("reads a distribution in display units, per sample and pooled, and a 2-D grid", async () => {
    const { call, getState } = fixture();
    const one = await call<AgentDistribution>("distribution", { x: "FSC-A", bins: 4, range: { x: [0, 2000] } });
    expect(one.series).toHaveLength(1);
    const s = one.series[0];
    expect(s.series).toBe("D1");
    expect(s.n).toBe(200);
    expect(s.x.edges).toEqual([0, 500, 1000, 1500, 2000]);
    expect(s.x.counts).toEqual([50, 50, 50, 50]);
    expect(s.x.quantiles["0.5"]).toBeCloseTo(995, 6);
    expect(s.x.min).toBe(0);
    expect(s.x.max).toBe(1990);
    expect(s.x.transform).toEqual(getState().root_population_id ? one.series[0].x.transform : null);
    const pooled = await call<AgentDistribution>("distribution", { x: "FSC-A", y: "SSC-A", pooled: true, bins: 2, range: { x: [0, 2000], y: [0, 2000] } });
    expect(pooled.series[0].series).toBe("pooled");
    expect(pooled.series[0].n).toBe(300);
    // Grid rows by y then x. D1 lies on the anti-diagonal: low x with high y and the reverse; D2 (x < 100, y = 500) is low x, low y.
    expect(pooled.series[0].grid).toEqual([100, 100, 100, 0]);
    expect(pooled.series[0].y!.counts).toEqual([200, 100]);
    const two = await call<AgentDistribution>("distribution", { x: "FSC-A", sampleIds: ["D2", "D1"], bins: 2 });
    expect(two.series.map((x) => x.series)).toEqual(["D2", "D1"]);
    expect(two.series[0].x.max).toBe(99);
  });

  it("names the valleys of a bimodal histogram and none for a flat one", () => {
    // Two modes of equal height with a dip between them: one valley, at the dip's midpoint.
    const counts = [0, 2, 8, 20, 8, 2, 1, 2, 8, 20, 8, 2, 0];
    const edges = counts.map((_, i) => i).concat([counts.length]);
    expect(valleysOf(counts, edges)).toEqual([6.5]);
    // Uniform counts: no valley. A dip of less than a tenth of the modes: none either.
    expect(valleysOf(new Array(12).fill(10), [...Array(13).keys()])).toEqual([]);
    expect(valleysOf([0, 10, 20, 30, 29, 30, 20, 10, 0], [...Array(10).keys()])).toEqual([]);
    // Three modes: two valleys, the deeper first.
    const three = [1, 10, 30, 10, 2, 10, 30, 10, 6, 10, 30, 10, 1];
    expect(valleysOf(three, three.map((_, i) => i).concat([three.length]))).toEqual([4.5, 8.5]);
  });

  it("summarises medians per population, sampling long populations", async () => {
    const { call, getState } = fixture();
    const root = getState().root_population_id!;
    const stats = await call<AgentStats>("stats", { populationIds: [root], channels: ["FSC-A", "CD4"], pooled: true });
    expect(stats.populations).toHaveLength(1);
    expect(stats.populations[0]).toMatchObject({ populationId: root, series: "pooled", n: 300, sampled: false });
    // 300 pooled values: D2's 0 … 99 and D1's 0, 10, … 90 are the 110 below 100; the 150th and 151st
    // sorted values are then D1's 490 and 500.
    expect(stats.populations[0].medians["FSC-A"]).toBe(495);
    expect(typeof stats.populations[0].medians["CD4"]).toBe("number");
    // The fraction at or above a threshold is over every event of the population, pooled: FSC-A ≥ 1000 is D1's 100 of 300.
    const above = await call<AgentStats>("stats", { populationIds: [root], channels: ["FSC-A"], thresholds: { "FSC-A": 1000 }, pooled: true });
    expect(above.populations[0].positive).toEqual({ "FSC-A": 100 / 300 });
    expect(above.populations[0].medians["FSC-A"]).toBe(495);
    // A threshold on a channel not listed still comes back.
    const ssc = await call<AgentStats>("stats", { populationIds: [root], channels: ["FSC-A"], thresholds: { "SSC-A": 500 } });
    expect(ssc.populations[0].positive).toEqual({ "SSC-A": 150 / 200 });
  });

  it("packs memberships per sample as the colData export does, and steers the view", async () => {
    const { call, refusal, getState, fits, reloads, pans } = fixture();
    const root = getState().root_population_id!;
    const applied = await call<AgentApplied>("apply", {
      command: { type: "createRange", name: "FSC high", parentId: root, x: "FSC-A", y: "SSC-A", space: "display", xBounds: [1000, null], yBounds: [null, null] },
      rationale: "A threshold.",
    });
    const popId = applied.created.populationIds[0];
    const m = await call<AgentMemberships>("memberships", { populationIds: [popId] });
    expect(m.populations).toHaveLength(1);
    const masks = m.populations[0].sampleMasks;
    expect(masks.map((x) => [x.sampleId, x.eventCount])).toEqual([["D1", 200], ["D2", 100]]);
    const bits = Buffer.from(masks[0].membershipBitsBase64, "base64");
    expect(bits).toHaveLength(25);
    // Events 0 … 99 are outside (FSC-A < 1000), 100 … 199 inside: the first 12 bytes are 0 and the last 12 are 0xff.
    expect([...bits.slice(0, 12)]).toEqual(new Array(12).fill(0));
    expect([...bits.slice(13)]).toEqual(new Array(12).fill(255));
    expect(bits[12]).toBe(0xf0);
    expect([...Buffer.from(masks[1].membershipBitsBase64, "base64")]).toEqual(new Array(13).fill(0));
    const view = await call<AgentView>("view", { populationId: popId, x: "CD4", y: "FSC-A", sampleId: "D2" });
    expect(view).toMatchObject({ populationId: popId, x: "CD4", y: "FSC-A", sampleId: "D2" });
    expect(fits()).toBe(0);
    await call<AgentView>("view", { x: "FSC-A", y: "CD4", fit: true });
    expect(fits()).toBe(1);
    expect(pans()).toBe(1);
    // Fit to the data: the whole extent over both files, 2% past the last event, widened to the
    // gates on these axes (the FSC high gate, closed at the data's edge, adds nothing here).
    const full = await call<AgentView>("view", { x: "FSC-A", y: "SSC-A", fit: "data" });
    expect(full.ranges.x![0]).toBeCloseTo(0 - 1990 * 0.02, 6);
    expect(full.ranges.x![1]).toBeCloseTo(1990 + 1990 * 0.02, 6);
    expect(full.ranges.y![0]).toBeCloseTo(0 - 1990 * 0.02, 6);
    expect(pans()).toBe(2);
    // A held range, as the Scales tab's Min/Max.
    const heldView = await call<AgentView>("view", { xRange: [100, 900] });
    expect(heldView.ranges.x).toEqual([100, 900]);
    expect((await refusal("view", { xRange: [900, 100] }))?.message).toContain("low below high");
    expect((await refusal("view", { fit: "yes" }))?.message).toContain('fit must be');
    // A population can be removed; its gate stays, as in the app.
    const removed = await call<AgentApplied>("apply", { command: { type: "deletePopulation", populationId: popId }, rationale: "Not needed." });
    expect(removed.populations.map((p) => p.name)).not.toContain("FSC high");
    expect(removed.gates).toHaveLength(1);
    expect((await refusal("apply", { command: { type: "deletePopulation", populationId: getState().root_population_id }, rationale: "x" }))?.message).toContain("root");
    expect(await call<{ reloading: boolean }>("reload")).toEqual({ reloading: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reloads()).toBe(1);
    const workspace = await call<{ json: string }>("workspace");
    expect(JSON.parse(workspace.json).gating.gate_order).toEqual(applied.created.gateIds);
  });
});

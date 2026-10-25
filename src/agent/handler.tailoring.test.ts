import { expect, it } from "vitest";
import { Sample } from "../engine/sample";
import { cloneHierarchyTree } from "../engine/hierarchies";
import { coreReducer, initialCoreState, recomputeGating } from "../store";
import { gatingStateForTree, workspaceHierarchyTrees } from "../host/hostedMemberships";
import { createAgentHandler, type AgentAdapter } from "./handler";
import type { AgentApplied, AgentDescribe, AgentDistribution, AgentMemberships, AgentPreview, AgentRequest, AgentStats } from "./protocol";

it("reads another sample through its population correspondence while a file's copy is active", async () => {
  const entries = [
    { id: "D1", rows: [[1, 1], [3, 1], [4, 4]] },
    { id: "D2", rows: [[1, 1], [1.5, 1], [3, 1], [4, 4]] },
  ].map((entry) => ({ ...entry, sample: new Sample({
    version: "FCS3.1", nEvents: entry.rows.length, instrument: "flow", keywords: {}, spillover: null,
    channels: ["FSC-A", "SSC-A"].map((name, index) => ({ index, name, marker: null, bits: 32, range: 1024 })),
    columns: [0, 1].map((i) => Float32Array.from(entry.rows.map((r) => r[i]))),
  }) }));
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 3 });
  const adapter: AgentAdapter = {
    info: () => ({ app: "GateLab", version: "test", host: "browser", workspaceName: null }),
    state: () => state,
    samples: () => entries.map((entry) => {
      const hierarchyId = state.file_hierarchies[entry.id] ?? state.hierarchies[0].id;
      const tree = workspaceHierarchyTrees(state).find((h) => h.id === hierarchyId)!;
      return {
        id: entry.id, name: `${entry.id}.fcs`, sample: entry.sample, viewed: entry.id === "D1", checked: true,
        metadata: {}, hierarchyId,
        // App supplies a sample assigned to an inactive tree with that tree's own IDs.
        gating: () => recomputeGating(entry.sample, tree.active ? state : gatingStateForTree(state, tree)),
      };
    }),
    dispatch: (action) => { state = coreReducer(state, action); },
    settled: async () => {},
    view: () => ({ populationId: state.active_population_id, sampleId: "D1", x: "FSC-A", y: "SSC-A", tab: "gating", ranges: { x: null, y: null } }),
    setView: async () => {}, render: async () => ({ png: "", width: 0, height: 0 }),
    workspaceJson: () => null, fit: () => {}, setAxisRange: () => {}, clearPan: () => {}, reload: () => {},
  };
  const handler = createAgentHandler(adapter);
  let seq = 0;
  const call = async <T,>(method: AgentRequest["method"], params?: unknown): Promise<T> => {
    const response = await handler.handle({ kind: "request", id: String(++seq), method, params });
    if (response.error) throw new Error(`${response.error.code}: ${response.error.message}`);
    return response.result as T;
  };
  await call<AgentApplied>("apply", { command: {
    type: "createGate", shape: "rectangle", name: "Selected", parentId: state.root_population_id,
    x: "FSC-A", y: "SSC-A", space: "raw", vertices: [[0, 0], [2, 2]],
  }, rationale: "Select the explicitly listed low-scatter events." });
  const source = state.active_hierarchy_id;
  const cloned = cloneHierarchyTree(state.populations, state.root_population_id!, state.gates, state.gate_order);
  const reverse = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([a, b]) => [b, a]));
  state = coreReducer(state, { type: "addHierarchyCopies", activeHierarchyId: "D1-copy", silent: true, assignments: { D1: "D1-copy" }, copies: [{
    id: "D1-copy", name: "D1 only", owner_sample_id: "D1", structure_locked: true, source_hierarchy_id: source,
    source_gate_ids: reverse(cloned.gateIdMap), source_population_ids: reverse(cloned.idMap),
    gates: cloned.gates, gate_order: cloned.gate_order, populations: cloned.populations,
    root_population_id: cloned.root_population_id, active_population_id: cloned.root_population_id, selected_pop_ids: [],
  }] });
  const described = await call<AgentDescribe>("describe");
  const populationId = described.populations.find((p) => p.name === "Selected")!.id;
  const gateId = described.gates.find((g) => g.name === "Selected")!.id;
  expect(described.populations.find((p) => p.id === populationId)!.counts.map((c) => c.n)).toEqual([1, 2]);
  const stats = await call<AgentStats>("stats", { populationIds: [populationId], sampleIds: ["D2"], channels: ["FSC-A"] });
  expect(stats.populations[0]).toMatchObject({ n: 2, medians: { "FSC-A": 1.25 } });
  const distribution = await call<AgentDistribution>("distribution", { populationId, sampleIds: ["D2"], x: "FSC-A", bins: 2, range: { x: [0, 2] } });
  expect(distribution.series[0]).toMatchObject({ n: 2, x: { counts: [0, 2] } });
  const edit = { type: "editGate", gateId, vertices: [[2, 0], [5, 5]] };
  const preview = await call<AgentPreview>("preview", { command: edit });
  expect(preview.populations.find((p) => p.id === populationId)!.counts.map((c) => c.n)).toEqual([2, 2]);
  const applied = await call<AgentApplied>("apply", { command: edit, rationale: "D1's two high-scatter events; D2 retains its original gate." });
  expect(applied.populations.find((p) => p.id === populationId)!.counts.map((c) => c.n)).toEqual([2, 2]);
  const membership = async () => {
    const currentId = (await call<AgentDescribe>("describe")).populations.find((p) => p.name === "Selected")!.id;
    const m = await call<AgentMemberships>("memberships", { populationIds: [currentId] });
    return m.populations[0].sampleMasks.map((mask) => [...Buffer.from(mask.membershipBitsBase64, "base64")]);
  };
  // D1: events 1 and 2. D2: events 0 and 1. These exact masks must survive the readout fix.
  expect(await membership()).toEqual([[6], [3]]);
  // Undo previews must resolve the file assignments in the hypothetical state, not the current
  // sample view: D1 will return to its high-scatter copy while D2 stays on the shared low gate.
  state = coreReducer(state, { type: "assignFileHierarchies", assignments: { D1: source } });
  expect(await membership()).toEqual([[1], [3]]);
  const assignmentPreview = await call<AgentPreview>("preview", { command: { type: "undo" } });
  expect(assignmentPreview.populations.find((p) => p.name === "Selected")!.counts.map((c) => c.n)).toEqual([2, 2]);
  expect(await membership()).toEqual([[1], [3]]);
  await call("apply", { command: { type: "undo" }, rationale: "Restore D1's file assignment." });
  expect(await membership()).toEqual([[6], [3]]);
  await call("apply", { command: { type: "undo" }, rationale: "Restore D1's original membership." });
  expect(await membership()).toEqual([[1], [3]]);
});

it("reads a population the other sample's tree lacks as not evaluated, and pools without it", async () => {
  const entries = [
    { id: "D1", rows: [[1, 1], [3, 1], [4, 4]] },
    { id: "D2", rows: [[1, 1], [1.5, 1], [3, 1], [4, 4]] },
  ].map((entry) => ({ ...entry, sample: new Sample({
    version: "FCS3.1", nEvents: entry.rows.length, instrument: "flow", keywords: {}, spillover: null,
    channels: ["FSC-A", "SSC-A"].map((name, index) => ({ index, name, marker: null, bits: 32, range: 1024 })),
    columns: [0, 1].map((i) => Float32Array.from(entry.rows.map((r) => r[i]))),
  }) }));
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 3 });
  const adapter: AgentAdapter = {
    info: () => ({ app: "GateLab", version: "test", host: "browser", workspaceName: null }),
    state: () => state,
    samples: () => entries.map((entry) => {
      const hierarchyId = state.file_hierarchies[entry.id] ?? state.hierarchies[0].id;
      const tree = workspaceHierarchyTrees(state).find((h) => h.id === hierarchyId)!;
      return {
        id: entry.id, name: `${entry.id}.fcs`, sample: entry.sample, viewed: entry.id === "D1", checked: true,
        metadata: {}, hierarchyId,
        gating: () => recomputeGating(entry.sample, tree.active ? state : gatingStateForTree(state, tree)),
      };
    }),
    dispatch: (action) => { state = coreReducer(state, action); },
    settled: async () => {},
    view: () => ({ populationId: state.active_population_id, sampleId: "D1", x: "FSC-A", y: "SSC-A", tab: "gating", ranges: { x: null, y: null } }),
    setView: async () => {}, render: async () => ({ png: "", width: 0, height: 0 }),
    workspaceJson: () => null, fit: () => {}, setAxisRange: () => {}, clearPan: () => {}, reload: () => {},
  };
  const handler = createAgentHandler(adapter);
  let seq = 0;
  const call = async <T,>(method: AgentRequest["method"], params?: unknown): Promise<T> => {
    const response = await handler.handle({ kind: "request", id: String(++seq), method, params });
    if (response.error) throw new Error(`${response.error.code}: ${response.error.message}`);
    return response.result as T;
  };
  // D1's unlocked tailored copy is live; D2 stays on the tree, which never gains "Extra".
  const source = state.active_hierarchy_id;
  const cloned = cloneHierarchyTree(state.populations, state.root_population_id!, state.gates, state.gate_order);
  const reverse = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([a, b]) => [b, a]));
  state = coreReducer(state, { type: "addHierarchyCopies", activeHierarchyId: "D1-copy", silent: true, assignments: { D1: "D1-copy" }, copies: [{
    id: "D1-copy", name: "D1 only", owner_sample_id: "D1", structure_locked: false, source_hierarchy_id: source,
    source_gate_ids: reverse(cloned.gateIdMap), source_population_ids: reverse(cloned.idMap),
    gates: cloned.gates, gate_order: cloned.gate_order, populations: cloned.populations,
    root_population_id: cloned.root_population_id, active_population_id: cloned.root_population_id, selected_pop_ids: [],
  }] });
  const create = {
    type: "createGate", shape: "rectangle", name: "Extra", parentId: state.root_population_id,
    x: "FSC-A", y: "SSC-A", space: "raw", vertices: [[0, 0], [10, 10]],
  };
  // Every D1 event; D2 is not evaluated, so it carries no count and stays out of the pool.
  const expectExtra = (populations: AgentDescribe["populations"]) => {
    const extra = populations.find((p) => p.name === "Extra")!;
    expect(extra.counts[0]).toEqual({ sampleId: "D1", n: 3, parentN: 3, percentOfParent: 100 });
    expect(extra.counts[1]).toMatchObject({ sampleId: "D2", n: null, percentOfParent: null });
    expect(extra.counts[1].notEvaluated).toMatch(/'Extra' of 'D1 only' was not evaluated for D2\.fcs/);
    expect(extra.pooled).toEqual({ n: 3, parentN: 3, percentOfParent: 100, percentOfTotal: 100 });
    return extra.id;
  };
  expectExtra((await call<AgentPreview>("preview", { command: create })).populations);
  expectExtra((await call<AgentApplied>("apply", { command: create, rationale: "Every event of D1." })).populations);
  const extraId = expectExtra((await call<AgentDescribe>("describe")).populations);
  const stats = await call<AgentStats>("stats", { populationIds: [extraId], sampleIds: ["D1", "D2"], channels: ["FSC-A"] });
  expect(stats.populations.map((p) => [p.series, p.n, p.notEvaluated?.length ?? 0])).toEqual([["D1", 3, 0], ["D2", 0, 1]]);
  const pooled = await call<AgentDistribution>("distribution", { populationId: extraId, pooled: true, x: "FSC-A", bins: 2 });
  expect(pooled.series[0].n).toBe(3);
  expect(pooled.series[0].notEvaluated).toHaveLength(1);
  // The host's export says the same: D2's membership of "Extra" is not evaluated, not empty.
  const m = await call<AgentMemberships>("memberships", { populationIds: [extraId] });
  expect(m.populations[0].sampleMasks.map((mask) => !!mask.notEvaluated)).toEqual([false, true]);
});

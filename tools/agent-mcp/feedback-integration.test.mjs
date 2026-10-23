// Real MCP framing, relay, handler, reducer and nested memberships. All data are synthetic.
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { Sample } from "../../src/engine/sample.ts";
import { coreReducer, initialCoreState, recomputeGating } from "../../src/store.ts";
import { createAgentHandler } from "../../src/agent/handler.ts";
import { startRelay } from "./relay.mjs";
import { serveMcp } from "./mcp.mjs";
import { gatelabTools } from "./tools.mjs";
import { auditTools, MCP_VERSION } from "./audit.mjs";
import { branchScopedGateOrder } from "../../src/engine/branchGates.ts";

const pack = (values) => {
  const data = Buffer.alloc(Math.ceil(values.length / 8));
  values.forEach((v,i) => { if (v) data[i >> 3] |= 1 << (i % 8); });
  return data.toString("base64");
};

export async function syntheticSession(sampleIds = ["D1", "D2"]) {
  const dir = await mkdtemp(join(tmpdir(), "gatelab-mcp-feedback-"));
  const sample = new Sample({ version: "FCS3.1", nEvents: 5, channels: ["FSC-A", "SSC-A"].map((name,index) => ({ index, name, marker: null, bits: 32, range: 20 })), columns: [Float32Array.of(1,2,3,4,5), Float32Array.of(1,2,3,4,5)], keywords: {}, spillover: null, instrument: "flow" });
  sample.channels.forEach((_,i) => sample.setScatterScale(i, "linear"));
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 5 });
  let task = null;
  const panning = { on: false, reads: 0 };
  const context = { assay: { id: null, space: null }, plot: { pooled: true, sampleIds: ["D1", "D2"] }, populationCountScope: "all-loaded-samples", gateCountScope: "geometry-within-active-population" };
  const info = { app: "GateLab", version: "test", host: "browser", workspaceName: "synthetic" };
  const handler = createAgentHandler({
    info: () => info, state: () => state, context: () => context,
    gatingTask: () => task, setGatingTask: async (next) => { task = next; },
    samples: () => sampleIds.map((id) => ({ id, name: id, sample, viewed: id === "D1", checked: true, metadata: { donor: id }, hierarchyId: state.active_hierarchy_id, gating: () => recomputeGating(sample, state) })),
    dispatch: (a) => { state = coreReducer(state, a); }, settled: async () => {},
    // `panning` moves the x range on every read, as a user panning the plot does.
    view: () => ({ populationId: state.active_population_id, sampleId: "D1", x: "FSC-A", y: "SSC-A", tab: "gating", ranges: { x: panning.on ? [0, ++panning.reads] : null, y: null } }),
    setView: async () => {}, render: async () => ({ png: "data:image/png;base64,AA==", width: 1, height: 1 }),
    workspaceJson: () => JSON.stringify(state), fit: () => {}, setAxisRange: () => {}, clearPan: () => {}, reload: () => {},
  });
  const relay = await startRelay({ port: 0, writer: "test-agent" });
  const socket = new WebSocket(relay.url);
  socket.on("message", async (data) => {
    const message = JSON.parse(String(data));
    if (message.kind === "hello") handler.setWriter(message.writer);
    if (message.kind === "request") socket.send(JSON.stringify(await handler.handle(message)));
  });
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.send(JSON.stringify({ kind: "hello", protocol: 1, info }));
  await relay.waitForTab(2000);
  const input = new PassThrough(), output = new PassThrough(), pending = new Map();
  let buffer = "", counter = 0;
  output.on("data", (chunk) => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) { const row = JSON.parse(buffer.slice(0,end)); buffer = buffer.slice(end+1); pending.get(row.id)?.(row); pending.delete(row.id); }
  });
  const path = join(dir, "audit.jsonl");
  const tools = await auditTools(gatelabTools(relay), { path, writer: "test-agent", declaredModel: "declared-test-model" });
  serveMcp({ name: "gatelab", version: MCP_VERSION, tools, input, output });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++counter;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("MCP reply timed out")); }, 5000);
    pending.set(id, (row) => { clearTimeout(timer); row.error ? reject(new Error(row.error.message)) : resolve(row.result); });
    input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = async (name, args = {}) => {
    const result = await rpc("tools/call", { name, arguments: args });
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  return { dir, path, context, panning, call, rpc, state: () => state, endSearch: () => { task = { ...task, status: "cancelled" }; }, select: (popId) => { state = coreReducer(state, { type: "setActivePopulation", popId }); }, close: async () => { socket.close(); await relay.close(); input.end(); output.end(); } };
}

describe("MCP feedback end to end", () => {
  it("iterates nested native-core previews, freezes by validation once, and leaves the live workspace untouched", async () => {
    const s = await syntheticSession(["D1", "D2", "D3"]);
    try {
      const d = await s.call("gatelab_describe"), root = d.rootPopulationId;
      const c = await s.call("gatelab_context");
      const referencePath = join(s.dir, "fit-reference.json"), historyPath = join(s.dir, "fit-history.jsonl");
      await writeFile(referencePath, JSON.stringify({ format: "gatelab-reference-masks", version: 1, label: "CD4_positive", eventOrder: "as-loaded", sampleManifestSha256: c.sampleManifestSha256, sampleMasks: ["D1", "D2"].map((sampleId) => ({ sampleId, eventCount: 5, membershipBitsBase64: pack([0,0,1,1,0]) })) }));
      const config = { mode: "cluster", target: "CD4_positive", budget: 2, historyPath, trainingSampleIds: ["D1"], validationSampleIds: ["D2"], references: [{ key: "positive", path: referencePath }] };
      await expect(s.call("gatelab_fit_start", { ...config, validationSampleIds: ["D1"] })).rejects.toThrow(/overlap/);
      expect((await s.call("gatelab_fit_start", config)).excludedSampleIds).toEqual(["D3"]);
      // While the search runs, the server scores only its training samples.
      const scoreOn = (sampleIds) => s.call("gatelab_evaluate", { referencePath, populationIds: [root], sampleIds });
      await expect(scoreOn(["D2"])).rejects.toThrow(/only its training samples.*Not scored now: D2/);
      await expect(scoreOn(["D1", "D3"])).rejects.toThrow(/Not scored now: D3/);
      expect((await scoreOn(["D1"])).pooled[0].n).toBe(5);
      const frozen = JSON.stringify(s.state());
      const command = { type: "createGate", shape: "rectangle", name: "Parent", parentId: root, x: "FSC-A", y: "SSC-A", space: "raw", vertices: [[0,0],[4.5,6]] };
      const candidate = { rationale: "First preserve the parent, then isolate the upper subgroup.", steps: [{ key: "parent", command }, { key: "child", command: { ...command, name: "CD4_positive", parentId: "@parent.population", vertices: [[1.5,0],[6,6]] } }], targets: { positive: "@child.population" } };
      const first = await s.call("gatelab_fit_candidate", candidate);
      expect(first.complexity).toMatchObject({ gates: 2, maxDepth: 2 });
      expect(first.training[0].pooled[0]).toMatchObject({ n: 5, tp: 2, fp: 1, fn: 0, f1: 0.8 });
      expect(first.training[0].perSample.every((r) => r.series === "D1")).toBe(true);
      const second = await s.call("gatelab_fit_candidate", { ...candidate, rationale: "Cut the low-low wedge without losing the positive events.", steps: [candidate.steps[0], { key: "child", command: { ...candidate.steps[1].command, shape: "polygon", vertices: [[1.5,1],[6,1],[6,6],[1,6],[1,1.5]] } }, { key: "tighten", command: { type: "editGate", gateId: "@child.gate", vertices: [[5,0],[6,0],[6,6],[0,6],[0,5]] } }] });
      expect(second.training[0].pooled[0].f1).toBe(1);
      await expect(s.call("gatelab_fit_candidate", candidate)).rejects.toThrow(/budget/);
      const result = await s.call("gatelab_fit_finish", { rationale: "Freeze the declared validation selection." });
      expect(result.applied).toBe(false);
      expect(result.validation).toHaveLength(2);
      expect(result.selected.id).toBe(2);
      expect(result.validation[0].feedback[0].perSample.every((r) => r.series === "D2")).toBe(true);
      // Frozen: validation may be scored again.
      expect((await scoreOn(["D2"])).pooled[0].n).toBe(5);
      expect(JSON.stringify(s.state())).toBe(frozen);
      expect((await s.call("gatelab_describe")).revision).toBe(d.revision);
      await expect(s.call("gatelab_fit_candidate", candidate)).rejects.toThrow(/frozen/);
      const history = (await readFile(historyPath, "utf8")).trim().split("\n").map(JSON.parse);
      expect(history.map((r) => r.event)).toEqual(["start", "candidate", "candidate", "frozen"]);
      await expect(s.call("gatelab_fit_start", config)).rejects.toThrow(/EEXIST/);
    } finally { await s.close(); }
  });
  it("keeps searching when the user selects a population in the tab", async () => {
    const s = await syntheticSession();
    try {
      const d0 = await s.call("gatelab_describe");
      const command = { type: "createGate", shape: "rectangle", name: "Marker high", parentId: d0.rootPopulationId, x: "FSC-A", y: "SSC-A", space: "raw", vertices: [[2,0],[6,6]] };
      const applied = await s.call("gatelab_apply", { command, rationale: "A live gate to click on.", expectedRevision: d0.revision });
      await s.call("gatelab_fit_start", { mode: "population", target: "A marker-low phenotype", budget: 2, historyPath: join(s.dir, "clicks.jsonl"), trainingSampleIds: ["D1", "D2"] });
      const before = (await s.call("gatelab_describe")).revision;
      s.select(applied.created.populationIds[0]);
      expect((await s.call("gatelab_describe")).revision).toBeGreaterThan(before);
      const candidate = { steps: [{ key: "low", command: { ...command, name: "Marker low", vertices: [[0,0],[2,6]] } }], rationale: "Searching on while the user looks around.", targets: { low: "@low.population" } };
      expect((await s.call("gatelab_fit_candidate", candidate)).populations).toHaveLength(1);
      await s.call("gatelab_fit_cancel");
    } finally { await s.close(); }
  });
  it("keeps phenotype mode free of invented reference scores and rejects edits to the baseline", async () => {
    const s = await syntheticSession();
    try {
      const d = await s.call("gatelab_describe");
      const config = { mode: "population", target: "A marker-high phenotype", budget: 3, historyPath: join(s.dir,"phenotype.jsonl"), trainingSampleIds: ["D1", "D2"] };
      await s.call("gatelab_fit_start", config);
      const command = { type: "createGate", shape: "rectangle", name: "Marker high", parentId: d.rootPopulationId, x: "FSC-A", y: "SSC-A", space: "raw", vertices: [[2,0],[6,6]] };
      const candidate = { steps: [{ key: "high", command }], rationale: "A described phenotype, without external labels.", targets: { high: "@high.population" } };
      const result = await s.call("gatelab_fit_candidate", candidate);
      expect(result.training).toBeNull(); expect(result.quality).toBeNull();
      const chosen = await s.call("gatelab_fit_finish", { candidateId: 1, rationale: "Choose for human phenotype review." });
      expect(chosen.validation).toEqual([]); expect(s.state().gate_order).toHaveLength(0);
      await s.call("gatelab_fit_start", { ...config, historyPath: join(s.dir,"stale.jsonl") });
      await s.call("gatelab_apply", { command, rationale: "A separate live edit.", expectedRevision: d.revision });
      await expect(s.call("gatelab_fit_candidate", candidate)).rejects.toThrow(/changed/);
      await s.call("gatelab_fit_cancel");
    } finally { await s.close(); }
  });
  it("scores two daughters under one shared parent, includes upstream losses, and honors user cancellation", async () => {
    const s = await syntheticSession();
    try {
      const d = await s.call("gatelab_describe"), context = await s.call("gatelab_context");
      const references = [];
      for (const [key, mask] of [["A", [0,0,1,0,0]], ["B", [0,0,0,1,0]]]) {
        const path = join(s.dir, `${key}.json`);
        await writeFile(path, JSON.stringify({ format: "gatelab-reference-masks", version: 1, label: key, eventOrder: "as-loaded", sampleManifestSha256: context.sampleManifestSha256, sampleMasks: ["D1", "D2"].map((sampleId) => ({ sampleId, eventCount: 5, membershipBitsBase64: pack(mask) })) }));
        references.push({ key, path });
      }
      await s.call("gatelab_fit_start", { mode: "cluster", target: "Two shared-parent daughters", budget: 2, historyPath: join(s.dir,"shared.jsonl"), trainingSampleIds: ["D1"], validationSampleIds: ["D2"], references, groupBy: "donor" });
      const base = { type: "createGate", shape: "rectangle", x: "FSC-A", y: "SSC-A", space: "raw" };
      const candidate = { rationale: "A too-tight parent loses daughter B before its terminal gate.", steps: [{ key: "parent", command: { ...base, name: "Shared parent", parentId: d.rootPopulationId, vertices: [[1.5,0],[3.5,6]] } }, { key: "A", command: { ...base, name: "A", parentId: "@parent.population", vertices: [[2.5,0],[3.5,6]] } }, { key: "B", command: { ...base, name: "B", parentId: "@parent.population", vertices: [[3.5,0],[4.5,6]] } }], targets: { A: "@A.population", B: "@B.population" } };
      const result = await s.call("gatelab_fit_candidate", candidate);
      expect(result.complexity.gates).toBe(3);
      expect(result.training.find((r) => r.key === "B").stages[1].targetLostAtStage).toBe(1);
      expect(result.training.find((r) => r.key === "B").pooled[0]).toMatchObject({ tp: 0, fn: 1, recall: 0 });
      s.endSearch();
      await expect(s.call("gatelab_fit_candidate", candidate)).rejects.toThrow(/ended/);
      await s.call("gatelab_fit_cancel");
      expect(s.state().gate_order).toHaveLength(0);
    } finally { await s.close(); }
  });
  it("closes a failed validation selection instead of allowing a new round of feedback", async () => {
    const s = await syntheticSession();
    try {
      const d = await s.call("gatelab_describe"), c = await s.call("gatelab_context"), path = join(s.dir,"absent.json");
      await writeFile(path, JSON.stringify({ format: "gatelab-reference-masks", version: 1, label: "CD4_positive", eventOrder: "as-loaded", sampleManifestSha256: c.sampleManifestSha256, sampleMasks: ["D1", "D2"].map((sampleId) => ({ sampleId, eventCount: 5, membershipBitsBase64: pack(sampleId === "D1" ? [0,1,1,0,0] : [0,0,0,0,0]) })) }));
      await s.call("gatelab_fit_start", { mode: "cluster", target: "CD4_positive", budget: 2, historyPath: join(s.dir,"absent-history.jsonl"), trainingSampleIds: ["D1"], validationSampleIds: ["D2"], references: [{ key: "positive", path }] });
      const candidate = { rationale: "Inspect an existing population without new geometry.", steps: [], targets: { positive: d.rootPopulationId } };
      await s.call("gatelab_fit_candidate", candidate);
      await expect(s.call("gatelab_fit_finish", { rationale: "Perform the single validation selection." })).rejects.toThrow(/No candidate met/);
      await expect(s.call("gatelab_fit_candidate", candidate)).rejects.toThrow(/frozen/);
    } finally { await s.close(); }
  });
  it("previews and applies nested gates, evaluates exact masks, exports consistently, and audits the actual commands", async () => {
    const s = await syntheticSession();
    try {
      const init = await s.rpc("initialize", {});
      expect(init.serverInfo.version).toBe(MCP_VERSION);
      const before = await s.call("gatelab_context");
      expect(before.plotSelection).toEqual({ pooled: true, sampleIds: ["D1", "D2"] });
      const root = before.activePopulationChain[0].id;
      const command = { type: "createGate", shape: "rectangle", name: "CD4_positive", parentId: root, x: "FSC-A", y: "SSC-A", space: "raw", vertices: [[0,0],[4,6]] };
      const preview = await s.call("gatelab_preview", { command });
      expect(preview.populations.find((p) => p.isNew).pooled.n).toBe(6);
      expect(s.state().gate_order).toHaveLength(0);
      const parent = await s.call("gatelab_apply", { command, rationale: "Synthetic threshold example.", expectedRevision: before.revision });
      const childCommand = { ...command, name: "Subset", parentId: parent.created.populationIds[0], vertices: [[1.5,0],[5.5,6]] };
      const child = await s.call("gatelab_apply", { command: childCommand, rationale: "Refine the existing parent.", expectedRevision: parent.revision });
      await expect(s.call("gatelab_apply", { command, rationale: "Stale command.", expectedRevision: before.revision })).rejects.toThrow(/conflict/);
      const c = await s.call("gatelab_context");
      const referencePath = join(s.dir, "reference.json");
      await writeFile(referencePath, JSON.stringify({ format: "gatelab-reference-masks", version: 1, label: "CD4_positive", eventOrder: "as-loaded", sampleManifestSha256: c.sampleManifestSha256, sampleMasks: ["D1", "D2"].map((sampleId) => ({ sampleId, eventCount: 5, membershipBitsBase64: pack([0,1,1,1,0]) })) }));
      const frozen = JSON.stringify(s.state());
      const score = await s.call("gatelab_evaluate", { referencePath, populationIds: child.created.populationIds, sampleIds: ["D1", "D2"], groupBy: "donor" });
      expect(score.pooled[0]).toMatchObject({ n: 10, tp: 4, fp: 0, fn: 2, tn: 4, precision: 1, recall: 2/3 });
      expect(score.stages[1].targetLostAtStage).toBe(2);
      expect(score.stages[2].targetLostAtStage).toBe(0);
      expect(JSON.stringify(s.state())).toBe(frozen);
      await s.call("gatelab_export", { path: join(s.dir, "export.json") });
      expect(JSON.parse(await readFile(join(s.dir, "export.json"), "utf8")).context.sampleManifestSha256).toBe(c.sampleManifestSha256);
      const audit = (await readFile(s.path,"utf8")).trim().split("\n").map(JSON.parse);
      expect(audit[0]).toMatchObject({ event: "session", writer: "test-agent", declaredModel: "declared-test-model", modelIdentitySource: "caller-declared" });
      expect(audit[0].sources["tools.mjs"]).toMatch(/^[a-f0-9]{64}$/);
      expect(audit.find((r) => r.event === "request" && r.arguments?.rationale === "Refine the existing parent.").arguments.command).toEqual(childCommand);
    } finally { await s.close(); }
  });
  it("reads feedback and exports while the user pans the plot", async () => {
    const s = await syntheticSession();
    try {
      const c = await s.call("gatelab_context");
      const referencePath = join(s.dir, "reference.json");
      await writeFile(referencePath, JSON.stringify({ format: "gatelab-reference-masks", version: 1, label: "CD4_positive", eventOrder: "as-loaded", sampleManifestSha256: c.sampleManifestSha256, sampleMasks: ["D1", "D2"].map((sampleId) => ({ sampleId, eventCount: 5, membershipBitsBase64: pack([0,1,1,1,0]) })) }));
      s.panning.on = true;
      const score = await s.call("gatelab_evaluate", { referencePath, populationIds: [c.activePopulationChain[0].id], sampleIds: ["D1", "D2"] });
      expect(score.pooled[0].n).toBe(10);
      await s.call("gatelab_export", { path: join(s.dir, "panned.json") });
      expect(s.panning.reads).toBeGreaterThan(2);
    } finally { await s.close(); }
  });
  it("rejects a changed plot/assay snapshot instead of assigning stale reference feedback", async () => {
    const s = await syntheticSession();
    try {
      const c = await s.call("gatelab_context");
      const referencePath = join(s.dir,"reference.json");
      await writeFile(referencePath, JSON.stringify({ format: "gatelab-reference-masks", version: 1, label: "CD4_positive", eventOrder: "as-loaded", sampleManifestSha256: c.sampleManifestSha256, sampleMasks: [] }));
      s.context.assay.id = "different";
      await expect(s.call("gatelab_evaluate", { referencePath, populationIds: [c.activePopulationChain[0].id], sampleIds: ["D1"] })).rejects.toThrow(/manifest/);
    } finally { await s.close(); }
  });
  it("explains why selecting a sibling gate widens branch visibility", () => {
    const populations = Object.fromEntries([["root",null,[]],["A","root",["ga"]],["B","root",["gb"]],["A1","A",["ga1"]],["B1","B",["gb1"]]].map(([id,parent,refs]) => [id,{ population_id: id, parent_id: parent, gate_refs: refs.map((gate_id) => ({ gate_id, include: true })) }]));
    const gates = Object.fromEntries(["ga","gb","ga1","gb1"].map((gate_id) => [gate_id,{gate_id}]));
    expect(branchScopedGateOrder(populations,gates,Object.keys(gates),"A","root",null)).toEqual(["ga1"]);
    expect(branchScopedGateOrder(populations,gates,Object.keys(gates),"A","root","gb1")).toEqual(["ga1","gb1"]);
  });
});

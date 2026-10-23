import { expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { coreReducer, initialCoreState } from "../../src/store.ts";

it("runs the standalone hosted replay through MCP and retains reloaded masks", async () => {
  const dir = await mkdtemp(join(tmpdir(),"gatelab-replay-test-"));
  const state = coreReducer(initialCoreState(),{type:"loadSample",nEvents:2});
  const input = {
    format:"gatelab-hosted-replay",version:1,
    dataset:{contractVersion:1,id:"synthetic",label:"Synthetic",instrument:"cytof",eventCount:2,channels:[{id:"X",label:"X"},{id:"Y",label:"Y"}],defaultAssayId:"exprs",assays:[{id:"exprs",label:"exprs",role:"transformed",coordinateSpace:"display",displayCofactor:5,revision:0,encoding:"channel-major-float32-le"}],samples:[{id:"D1",label:"D1",eventCount:2,metadata:{donor:"D1"},assayByteLength:16,eventIndexEncoding:"uint32-le",eventIndexByteLength:8}]},
    payloads:{D1:{assay:Buffer.from(Float32Array.of(1,2,3,4).buffer).toString("base64"),eventIndex:Buffer.from(Uint32Array.of(0,1).buffer).toString("base64")}},
    workspace:{gating:{gates:state.gates,gate_order:state.gate_order,populations:state.populations,root_population_id:state.root_population_id,active_population_id:state.active_population_id,selected_gate_id:null}},
    expectedMemberships:{populations:[{id:state.root_population_id,sampleMasks:[{sampleId:"D1",eventCount:2,membershipBitsBase64:"Aw=="}]}]},
  };
  const file=join(dir,"input.json"),out=join(dir,"run");
  await writeFile(file,JSON.stringify(input));
  await promisify(execFile)(process.execPath,[resolve("tools/agent-mcp/replay.mjs"),"--input",file,"--out",out],{timeout:30000,cwd:dir});
  const report=JSON.parse(await readFile(join(out,"report.json"),"utf8"));
  expect(report.concordance).toMatchObject([{events:2,disagreements:0}]);
  expect(report.persistence).toMatchObject([{events:2,disagreements:0}]);
  expect(report.sourceRevision).toMatch(/^[a-f0-9]{40}$/);
},40000);

it("replays a sample on the tailored copy of the tree the workspace assigns it", async () => {
  const { loadHostedDataset } = await import("../../src/host/hostedSample.ts");
  const { recomputeGating } = await import("../../src/store.ts");
  const dir = await mkdtemp(join(tmpdir(),"gatelab-replay-test-"));
  const events = 4;
  // Channel-major: X then Y, the same values in both files.
  const assay = () => Buffer.from(Float32Array.of(1,2,3,4, 1,2,3,4).buffer).toString("base64");
  const index = () => Buffer.from(Uint32Array.of(0,1,2,3).buffer).toString("base64");
  const sample = (id) => ({ id, label: id, eventCount: events, metadata: { donor: id }, assayByteLength: 32, eventIndexEncoding: "uint32-le", eventIndexByteLength: 16 });
  const dataset = { contractVersion:1, id:"synthetic", label:"Synthetic", instrument:"cytof", eventCount:2*events, channels:[{id:"X",label:"X"},{id:"Y",label:"Y"}], defaultAssayId:"exprs", assays:[{id:"exprs",label:"exprs",role:"transformed",coordinateSpace:"display",displayCofactor:5,revision:0,encoding:"channel-major-float32-le"}], samples:[sample("D1"), sample("D2")] };
  const payloads = { D1: { assay: assay(), eventIndex: index() }, D2: { assay: assay(), eventIndex: index() } };

  // The tree: one gate keeping the low X events. D2's copy of it keeps every event.
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: events });
  const rootId = state.root_population_id;
  state = coreReducer(state, { type: "addGate", gateType: "rectangle", name: "Low", xChannel: "X", yChannel: "Y", vertices: [[-100,-100],[2.5,100]], createPop: { name: "Low", parentId: rootId } });
  const gateId = state.gate_order[0];
  const popId = Object.values(state.populations).find((p) => p.name === "Low").population_id;
  const mainId = state.active_hierarchy_id;
  const copyGates = { gC: { ...state.gates[gateId], gate_id: "gC", vertices: [[-100,-100],[100,100]] } };
  const copyPops = {
    rootC: { ...state.populations[rootId], population_id: "rootC", children: ["posC"] },
    posC: { ...state.populations[popId], population_id: "posC", parent_id: "rootC", gate_refs: [{ gate_id: "gC", include: true }] },
  };
  const copyRef = { id: "copyD2", name: "D2 copy", owner_sample_id: "D2", structure_locked: true, source_hierarchy_id: mainId, source_gate_ids: { gC: gateId }, source_population_ids: { rootC: rootId, posC: popId } };
  const workspace = {
    samples: [{ sampleId: "D1" }, { sampleId: "D2", hierarchyId: "copyD2" }],
    gating: {
      gates: state.gates, gate_order: state.gate_order, populations: state.populations, root_population_id: rootId,
      active_population_id: rootId, selected_gate_id: null, perFileHierarchies: true,
      hierarchies: [...state.hierarchies, copyRef], active_hierarchy_id: mainId,
      stored_hierarchies: [{ ...copyRef, gates: copyGates, gate_order: ["gC"], populations: copyPops, root_population_id: "rootC", active_population_id: "rootC" }],
    },
  };

  // What the app gives: D1 under the tree, D2 under its copy.
  const port = { readAssay: async (_d, id) => { const b = Buffer.from(payloads[id].assay, "base64"); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }, readEventIndex: async (_d, id) => { const b = Buffer.from(payloads[id].eventIndex, "base64"); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } };
  const [d1, d2] = await loadHostedDataset(port, dataset);
  const pack = (mask) => { const out = Buffer.alloc(Math.ceil(mask.length / 8)); mask.forEach((v, i) => { if (v) out[i >> 3] |= 1 << (i % 8); }); return out.toString("base64"); };
  const d1Mask = recomputeGating(d1.sample, state).masks[popId];
  const d2Own = recomputeGating(d2.sample, { ...state, gates: copyGates, gate_order: ["gC"], populations: copyPops, root_population_id: "rootC" }).masks.posC;
  const d2UnderTree = recomputeGating(d2.sample, state).masks[popId];
  // The copy must count differently, or the test could not tell the trees apart.
  expect(pack(d2Own)).not.toBe(pack(d2UnderTree));

  const input = {
    format:"gatelab-hosted-replay", version:1, dataset, payloads, workspace,
    expectedMemberships: { populations: [{ id: popId, sampleMasks: [
      { sampleId: "D1", eventCount: events, membershipBitsBase64: pack(d1Mask) },
      { sampleId: "D2", eventCount: events, membershipBitsBase64: pack(d2Own) },
    ] }] },
  };
  const file = join(dir,"input.json"), out = join(dir,"run");
  await writeFile(file, JSON.stringify(input));
  await promisify(execFile)(process.execPath, [resolve("tools/agent-mcp/replay.mjs"), "--input", file, "--out", out], { timeout: 30000, cwd: dir });
  const report = JSON.parse(await readFile(join(out,"report.json"),"utf8"));
  expect(report.concordance).toEqual([
    { populationId: popId, sampleId: "D1", events, disagreements: 0 },
    { populationId: popId, sampleId: "D2", events, disagreements: 0 },
  ]);
  expect(report.persistence.every((r) => r.disagreements === 0)).toBe(true);
}, 60000);

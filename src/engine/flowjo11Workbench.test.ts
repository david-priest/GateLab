// @vitest-environment jsdom
//
// The FlowJo 11 workbench reader (flowjo11Workbench.ts): a .flowjo written here from synthetic
// samples, gates and events, read through the FlowJo workspace path, and each population counted.
// Every name is synthetic.

import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { flowJo11WorkbenchToWorkspace, isFlowJo11WorkbenchBytes, readFlowJo11Workbench } from "./flowjo11Workbench";
import { flowJoWorkspaceToGatingML, listFlowJoWorkspaceSamples } from "./flowjoWorkspace";
import { importGatingML, restoreGatingMLScaleState } from "./gatingml";
import { applyGatingStrategy } from "./populations";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import { flowJoGridScale, parseFlowJoGridSpec, sameFlowJoGridSpec } from "./flowjoGrid";
import { biexBreakpoints, FLOWJO_BIEX_TABLE_CHANNELS } from "./biex";
import { WORKSPACE_FEATURES, requiredWorkspaceFeatures } from "./workspaceFeatures";

const LINEAR = { transformType: "Linear", minRange: 0, maxRange: 262144 };
const LOG = { transformType: "Log", decadesOffset: 10, numberDecades: 4, shift: 0, negate: false };
const axis = (name: string, transform: object) => ({ parameterSpec: { name }, transform });

/** Raw value of a display position (0 to 256) on the 0 to 262144 linear axis. */
const lin = (d: number) => (d * 262144) / 256;

interface GateSpec {
  id: string;
  type: string;
  names: string[];
  gate?: object;
  desync?: Record<string, object>;
}
interface PopSpec {
  /** One per sample: the population id is `${gate}:${sample}:${number}`. */
  gate: string;
  number?: number;
  parents: string[];
}

/** A workbench with the given samples, gates and per-sample populations, zipped as FlowJo 11 does. */
function workbench(samples: string[], gates: GateSpec[], tree: PopSpec[]): Uint8Array {
  const dataSources: Record<string, object> = {};
  const populationDefinitions: Record<string, object> = {
    root: { uuid: "root", definition: { name: ["Ungated"], type: "root", kind: "ungated" }, parents: {}, children: {} },
  };
  for (const g of gates) {
    populationDefinitions[g.id] = {
      uuid: g.id,
      definition: {
        name: g.names, type: g.type === "not" || g.type === "and" || g.type === "or" ? g.type : g.type === "quad" ? "quad" : "gate",
        kind: "general",
        ...(g.gate ? { gateDefinition: { uuid: g.id, ...g.gate } } : {}),
        desyncTable: g.desync ?? {},
      },
      parents: {}, children: {},
    };
  }
  const populations: Record<string, object> = {};
  for (const s of samples) {
    dataSources[s] = {
      uuid: s,
      definition: { uri: `/data/${s}.fcs`, customKeywords: { "File Name": `${s}.fcs`, "File URI": `/data/${s}.fcs`, "Compensation Matrix": "" }, transforms: [] },
      parents: { cytometers: [], platforms: [] },
      results: { keywords: { $FIL: `${s}.fcs` } },
    };
    populations[`root:${s}`] = { uuid: `root:${s}`, definition: { populationNumber: 0 }, parents: { _dataSource: [s], populationDefinitions: ["root"] }, results: { count: 0 } };
    for (const p of tree) {
      const id = `${p.gate}:${s}:${p.number ?? 0}`;
      populations[id] = {
        uuid: id,
        definition: { populationNumber: p.number ?? 0 },
        parents: {
          _dataSource: [s], populationDefinitions: [p.gate],
          // A parent is "root", a gate ("g1"), or one quadrant of a gate ("q:2").
          populations: p.parents.map((q) => {
            if (q === "root") return `root:${s}`;
            const [gate, n] = q.split(":");
            return `${gate}:${s}:${n ?? 0}`;
          }),
        },
        results: { count: 0 },
      };
    }
  }
  const analysis = { schemaVersion: "3.0.0", analysisUUID: "a1", dataSources, populationDefinitions, populations, cytometers: {}, platforms: {}, groups: {} };
  return zipSync({
    "workbench.json": strToU8(JSON.stringify({ id: "w1", name: "synthetic", analyses: ["a1"] })),
    "preferences.json": strToU8(JSON.stringify({ version: "4.0.0" })),
    "analyses/analysis-a1/analysis-a1.json": strToU8(JSON.stringify(analysis)),
    "analyses/analysis-a1/analysis-a1_manifest.txt": strToU8("[]"),
  });
}

function fcs(columns: Record<string, number[]>): FcsFile {
  const names = Object.keys(columns);
  const n = columns[names[0]].length;
  return {
    version: "FCS3.1", nEvents: n, instrument: "flow", keywords: {},
    channels: names.map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
    columns: names.map((name) => Float32Array.from(columns[name])),
    spillover: null,
  } as unknown as FcsFile;
}

/** Each population's member events in one sample of a workbench, by name. */
function counted(bytes: Uint8Array, sampleIndex: number, columns: Record<string, number[]>) {
  const xml = flowJo11WorkbenchToWorkspace(readFlowJo11Workbench(bytes));
  const conv = flowJoWorkspaceToGatingML(xml, sampleIndex, null, undefined, { flowJoGrid: true });
  const sample = new Sample(fcs(columns));
  const res = importGatingML(conv.gatingMl, sample.channels.map((c) => c.key), {}, sample.instrument);
  const { masks } = applyGatingStrategy(res.gates, res.populations, res.root_population_id, sample.gateAssayData());
  const out: Record<string, number[]> = {};
  for (const [pid, pop] of Object.entries(res.populations)) {
    if (pid === res.root_population_id) continue;
    out[pop.name] = Array.from(masks[pid]).flatMap((m, i) => (m ? [i] : []));
  }
  return { out, conv, res };
}

describe("reading a FlowJo 11 workbench", () => {
  it("recognises a workbench by its content and refuses one with several analyses", () => {
    const bytes = workbench(["D1"], [], []);
    expect(isFlowJo11WorkbenchBytes(bytes)).toBe(true);
    expect(isFlowJo11WorkbenchBytes(strToU8("<Workspace/>"))).toBe(false);
    const two = zipSync({ "workbench.json": strToU8(JSON.stringify({ name: "x", analyses: ["a", "b"] })) });
    expect(() => readFlowJo11Workbench(two)).toThrow(/holds 2 analyses/);
  });

  it("lists every sample, named by its file", () => {
    const bytes = workbench(["D1", "D2"], [], []);
    const samples = listFlowJoWorkspaceSamples(flowJo11WorkbenchToWorkspace(readFlowJo11Workbench(bytes)));
    expect(samples.map((s) => s.name)).toEqual(["D1.fcs", "D2.fcs"]);
    expect(samples[0].candidateFileNames).toContain("D1.fcs");
  });
});

describe("FlowJo 11's polygon rule", () => {
  // A square with its left edge at display 10.5 on a linear axis. FlowJo 11 puts an event on the
  // channel its value falls in, rounded down: 10.6 is channel 10, outside; FlowJo 10 rounds it to
  // 11, inside. 11.2 is channel 11 under both rules, inside.
  const square = { type: "polygon", xAxis: axis("FSC-A", LINEAR), yAxis: axis("SSC-A", LINEAR), xVertices: [10.5, 40.5, 40.5, 10.5], yVertices: [10.5, 10.5, 40.5, 40.5] };
  const bytes = workbench(["D1"], [{ id: "g1", type: "polygon", names: ["CD4_positive"], gate: square }], [{ gate: "g1", parents: ["root"] }]);
  const columns = { "FSC-A": [lin(10.6), lin(11.2), lin(39.9), lin(41)], "SSC-A": [lin(20), lin(20), lin(20), lin(20)] };

  it("puts each event on the channel it falls in, rounded down, and keeps the vertices where FlowJo 11 saved them", () => {
    const { out, res } = counted(bytes, 0, columns);
    expect(out.CD4_positive).toEqual([1, 2]);
    const g = Object.values(res.gates)[0];
    expect(g.gate_type === "polygon" && g.vertices[0]).toEqual([10.5, 10.5]);
    expect(Object.values(g.transforms!).map((t) => t.kind === "flowjoChannels" && t.rule)).toEqual(["flowjo11", "flowjo11"]);
  });

  it("is FlowJo 11's own grid: an event's channel and a vertex's place differ from FlowJo 10's", () => {
    const a = { kind: "linear" as const, minRange: 0, maxRange: 262144 };
    const fj11 = flowJoGridScale({ kind: "flowjoChannels", channels: 256, axis: a, rule: "flowjo11" });
    const fj10 = flowJoGridScale({ kind: "flowjoChannels", channels: 256, axis: a });
    expect([fj11.eventCell(lin(10.6)), fj10.eventCell(lin(10.6))]).toEqual([10, 11]);
    expect([fj11.vertexCell(lin(10.6)), fj10.vertexCell(lin(10.6))]).toEqual([10.6, 11]);
    const spec = parseFlowJoGridSpec({ kind: "flowjoChannels", channels: 256, axis: a, rule: "flowjo11" });
    expect(spec?.rule).toBe("flowjo11");
    expect(sameFlowJoGridSpec(spec!, { kind: "flowjoChannels", channels: 256, axis: a })).toBe(false);
    expect(parseFlowJoGridSpec({ kind: "flowjoChannels", channels: 256, axis: a, rule: "other" })).toBeNull();
  });

  it("makes a workspace holding it one an older GateLab refuses", () => {
    const a = { kind: "linear", minRange: 0, maxRange: 262144 };
    expect(requiredWorkspaceFeatures({ g: { kind: "flowjoChannels", channels: 256, axis: a, rule: "flowjo11" } }))
      .toContain(WORKSPACE_FEATURES.flowjo11Grid);
    expect(requiredWorkspaceFeatures({ g: { kind: "flowjoChannels", channels: 256, axis: a } }))
      .not.toContain(WORKSPACE_FEATURES.flowjo11Grid);
  });
});

describe("each gate on its own axes", () => {
  it("evaluates two gates on one parameter on the different transforms each was drawn on", () => {
    // Range on a linear axis, and a range on a log axis (offset 10, 4 decades), both on B-A.
    const linRange = { type: "range", xAxis: axis("B-A", LINEAR), xVertices: [0, 1], yVertices: [5, 5] };
    const logRange = { type: "range", xAxis: axis("B-A", LOG), xVertices: [64, 128], yVertices: [5, 5] };
    const bytes = workbench(["D1"], [
      { id: "g1", type: "range", names: ["Lin"], gate: linRange },
      { id: "g2", type: "range", names: ["Log"], gate: logRange },
    ], [{ gate: "g1", parents: ["root"] }, { gate: "g2", parents: ["root"] }]);
    // Log display 64 is 10 · 10^1 = 100 and 128 is 10 · 10^2 = 1000. Linear display 1 is 1024.
    const { out } = counted(bytes, 0, { "B-A": [50, 500, 5000], "SSC-A": [1, 1, 1] });
    expect(out.Lin).toEqual([0, 1]);
    expect(out.Log).toEqual([1]);
  });
});

describe("quadrants, Booleans and sample-specific gates", () => {
  // Arms: [centre, down, right, up, left]. The up arm divides the upper half at x 100, the down
  // arm the lower half at x 50; both horizontal arms are at y 100. Moving one vertical arm is what
  // a FlowJo 11 workbench has been measured with (one sample, all four counts FlowJo's own).
  const quad = {
    type: "quad", xAxis: axis("FSC-A", LINEAR), yAxis: axis("SSC-A", LINEAR),
    xVertices: [75, 50, 293, 100, 0], yVertices: [100, -37, 100, 256, 100],
  };
  const names = ["Q4:x-,y-", "Q3:x+,y-", "Q1:x-,y+", "Q2:x+,y+"];
  const bytes = workbench(["D1", "D2"], [
    { id: "q", type: "quad", names, gate: quad, desync: { D2: { ...quad, xVertices: [75, 20, 293, 100, 0] } } },
    { id: "n", type: "not", names: ["Not gate of Q2:x+,y+"] },
    { id: "a", type: "and", names: ["And gate of Q1, Q2"] },
  ], [
    ...[0, 1, 2, 3].map((number) => ({ gate: "q", number, parents: ["root"] })),
    { gate: "n", parents: ["q:3"] },
    { gate: "a", parents: ["q:2", "q:3"] },
  ]);
  // Event 0: x 60, y 110 → upper half, left of 100 → Q1. Event 1: x 60, y 70 → lower half, right
  // of 50 → Q3 (D1); with D2's down arm at 20, also Q3. Event 2: x 30, y 70 → lower half: left of
  // 50 → Q4 in D1; right of 20 → Q3 in D2. Event 3: x 150, y 130 → Q2.
  const columns = { "FSC-A": [lin(60), lin(60), lin(30), lin(150)], "SSC-A": [lin(110), lin(70), lin(70), lin(130)] };

  it("divides the plot with each arm a boundary of its own", () => {
    const { out } = counted(bytes, 0, columns);
    expect(out["Q1:x-,y+"]).toEqual([0]);
    expect(out["Q3:x+,y-"]).toEqual([1]);
    expect(out["Q4:x-,y-"]).toEqual([2]);
    expect(out["Q2:x+,y+"]).toEqual([3]);
  });

  it("reads a NOT as its operand's parent without the operand, and an AND of disjoint quadrants as empty", () => {
    const { out } = counted(bytes, 0, columns);
    expect(out["Not gate of Q2:x+,y+"]).toEqual([0, 1, 2]);
    expect(out["And gate of Q1, Q2"]).toEqual([]);
  });

  it("gives a sample its own adjusted gate and the others the shared one", () => {
    const { out } = counted(bytes, 1, columns);
    expect(out["Q4:x-,y-"]).toEqual([]);
    expect(out["Q3:x+,y-"]).toEqual([1, 2]);
  });
});

describe("what GateLab cannot hold", () => {
  it("reports an OR by name and skips it", () => {
    const quad = { type: "quad", xAxis: axis("FSC-A", LINEAR), yAxis: axis("SSC-A", LINEAR), xVertices: [75, 75, 293, 75, 0], yVertices: [100, -37, 100, 256, 100] };
    const bytes = workbench(["D1"], [
      { id: "q", type: "quad", names: ["Q4", "Q3", "Q1", "Q2"], gate: quad },
      { id: "o", type: "or", names: ["Or gate of Q1, Q2"] },
    ], [...[0, 1, 2, 3].map((number) => ({ gate: "q", number, parents: ["root"] })), { gate: "o", parents: ["q:2", "q:3"] }]);
    const { conv, out } = counted(bytes, 0, { "FSC-A": [lin(10)], "SSC-A": [lin(10)] });
    expect(conv.warnings.some((w) => /"Or gate of Q1, Q2" combines its references with OR/.test(w))).toBe(true);
    expect(out["Or gate of Q1, Q2"]).toBeUndefined();
  });

  it("reports a gate on a shifted log axis rather than reading it on another", () => {
    const shifted = { ...LOG, shift: 5 };
    const bytes = workbench(["D1"], [
      { id: "g", type: "rectangle", names: ["Shifted"], gate: { type: "rectangle", xAxis: axis("FSC-A", shifted), yAxis: axis("SSC-A", LINEAR), xVertices: [10, 20], yVertices: [10, 20] } },
    ], [{ gate: "g", parents: ["root"] }]);
    expect(() => counted(bytes, 0, { "FSC-A": [1], "SSC-A": [1] })).toThrow(/"Shifted" uses LogAxisGate/);
  });
});

describe("curly quadrants", () => {
  // Centre (100, 100) on linear axes. FlowJo 11 bends the arm to the right of the crosshair up by
  // (distance)² / 1000 channels: at x 150 it is at y 102.5. An event at (150, 101) is therefore
  // below the arm, in Q3, where a straight crosshair would put it in Q2.
  const curly = { type: "curlyQuad", xAxis: axis("FSC-A", LINEAR), yAxis: axis("SSC-A", LINEAR), xVertices: [100], yVertices: [100] };
  const bytes = workbench(["D1"], [{ id: "c", type: "curlyQuad", names: ["Q4", "Q3", "Q1", "Q2"], gate: curly }],
    [0, 1, 2, 3].map((number) => ({ gate: "c", number, parents: ["root"] })));
  const columns = { "FSC-A": [lin(150), lin(150), lin(50)], "SSC-A": [lin(101), lin(104), lin(150)] };

  it("is one quadrant gate with FlowJo 11's curve, its four quadrants as populations", () => {
    const { out, res } = counted(bytes, 0, columns);
    const quadrants = Object.values(res.gates).filter((g) => g.gate_type === "quadrant");
    expect(quadrants).toHaveLength(1);
    const q = quadrants[0];
    expect(q.gate_type === "quadrant" && q.curl).toEqual({ power: 2, kx: 0.001, ky: 0.001 });
    expect(out.Q3).toEqual([0]);
    expect(out.Q2).toEqual([1]);
    expect(out.Q1).toEqual([2]);
  });
});

describe("plain quadrants", () => {
  // All four arms at the centre (100, 100): the straight crosshair, which GateLab holds as one
  // quadrant gate. The event at (150, 101) that a curly quadrant puts in Q3 is in Q2 here.
  const plain = { type: "quad", xAxis: axis("FSC-A", LINEAR), yAxis: axis("SSC-A", LINEAR), xVertices: [100, 100, 293, 100, 0], yVertices: [100, -37, 100, 256, 100] };
  const bytes = workbench(["D1"], [{ id: "q", type: "quad", names: ["Q4", "Q3", "Q1", "Q2"], gate: plain }],
    [0, 1, 2, 3].map((number) => ({ gate: "q", number, parents: ["root"] })));
  const columns = { "FSC-A": [lin(150), lin(150), lin(50), lin(50)], "SSC-A": [lin(101), lin(50), lin(150), lin(50)] };

  it("is one straight quadrant gate, its four quadrants as populations", () => {
    const { conv, out, res } = counted(bytes, 0, columns);
    expect(conv.warnings.filter((w) => /curly quadrant/.test(w))).toEqual([]);
    const quadrants = Object.values(res.gates).filter((g) => g.gate_type === "quadrant");
    expect(quadrants).toHaveLength(1);
    expect(quadrants[0].gate_type === "quadrant" && quadrants[0].curl).toBeFalsy();
    expect(Object.values(res.gates).filter((g) => g.gate_type === "rectangle")).toHaveLength(0);
    expect(out.Q2).toEqual([0]);
    expect(out.Q3).toEqual([1]);
    expect(out.Q1).toEqual([2]);
    expect(out.Q4).toEqual([3]);
  });
  it("is four rectangles in every sample where one sample adjusted its arms, so the files' trees match", () => {
    const adjusted = workbench(["D1", "D2"], [
      { id: "q", type: "quad", names: ["Q4", "Q3", "Q1", "Q2"], gate: plain, desync: { D2: { ...plain, xVertices: [100, 100, 293, 40, 0] } } },
    ], [0, 1, 2, 3].map((number) => ({ gate: "q", number, parents: ["root"] })));
    for (const sample of [0, 1]) {
      const { res } = counted(adjusted, sample, columns);
      const kinds = Object.values(res.gates).map((g) => g.gate_type);
      expect(kinds.filter((k) => k === "quadrant")).toHaveLength(0);
      expect(kinds.filter((k) => k === "rectangle")).toHaveLength(4);
    }
    // D1 keeps the straight crosshair; D2's up arm at 40 puts (50, 150) in Q2.
    expect(counted(adjusted, 0, columns).out.Q1).toEqual([2]);
    expect(counted(adjusted, 1, columns).out.Q2).toEqual([0, 2]);
  });
});

describe("the axis a gate was drawn on", () => {
  const BIEX = { transformType: "Biex", T: 262144, A: 0, M: 4.5, W: -100, vectorLength: 256 };
  const bytes = workbench(["D1"], [
    { id: "r", type: "range", names: ["CD3_positive"], gate: { type: "range", xAxis: axis("B-A", BIEX), xVertices: [120, 200], yVertices: [5, 5] } },
  ], [{ gate: "r", parents: ["root"] }]);

  it("is how the import shows the channel, found by its parameter name when the channel has a marker", () => {
    const xml = flowJo11WorkbenchToWorkspace(readFlowJo11Workbench(bytes));
    const conv = flowJoWorkspaceToGatingML(xml, 0, null, undefined, { flowJoGrid: true });
    const file = fcs({ "B-A": [100, 1000, 10000], "SSC-A": [1, 1, 1] });
    (file.channels[0] as { marker: string | null }).marker = "CD3";
    const sample = new Sample(file);
    const pnnMap: Record<string, string> = {};
    for (const c of sample.channels) pnnMap[c.pnn] = c.key;
    const res = importGatingML(conv.gatingMl, sample.channels.map((c) => c.key), pnnMap, sample.instrument);
    expect(res.scales?.["B-A"]?.biex).toMatchObject({ maxValue: 262144, pos: 4.5, neg: 0, widthBasis: -100, channelRange: 256 });
    restoreGatingMLScaleState(sample, res.scales, res.cytof_cofactor);
    const idx = sample.channels.findIndex((c) => c.pnn === "B-A");
    expect(sample.channels[idx].key).not.toBe("B-A");
    expect(sample.fluorBiexParams(idx)).toMatchObject({ maxValue: 262144, pos: 4.5, widthBasis: -100 });
  });
});

describe("a plain quadrant's arm on a biex axis", () => {
  // FlowJo 11 tests the arm with the event on its 4096-entry table: above the arm where the entry at
  // or below the event is at or above the entry at or below the arm (S6, 2026-10-23: all 196
  // quadrant populations). The horizontal arm at display 92.6143 is 0.83 of the way through entry
  // 1481; an event 0.4 of the way through that entry (display 92.5875) is below the arm as a value
  // but on its entry, so above it, and one in entry 1480 below it.
  const BIEX = { transformType: "Biex", T: 262144, A: 0, M: 4.5, W: -100, vectorLength: 256, autoWidthBasis: false };
  const { raw: table } = biexBreakpoints({ maxValue: 262144, pos: 4.5, neg: 0, widthBasis: -100, channelRange: 256, tableChannels: FLOWJO_BIEX_TABLE_CHANNELS });
  const at = (entry: number) => table[Math.floor(entry)] + (entry - Math.floor(entry)) * (table[Math.floor(entry) + 1] - table[Math.floor(entry)]);
  const arm = 1481.83 / 16;
  const plain = { type: "quad", xAxis: axis("FL1-A", BIEX), yAxis: axis("FL2-A", BIEX), xVertices: [100, 100, 293, 100, 0], yVertices: [arm, -37, arm, 256, arm] };
  const columns = { "FL1-A": [at(800), at(800), at(800), at(2400)], "FL2-A": [at(1481.4), at(1480.5), at(1482.2), at(1481.4)] };

  it("puts an event on the arm's table entry above it, as FlowJo 11 does", () => {
    const bytes = workbench(["D1"], [{ id: "q", type: "quad", names: ["Q4", "Q3", "Q1", "Q2"], gate: plain }],
      [0, 1, 2, 3].map((number) => ({ gate: "q", number, parents: ["root"] })));
    const { out } = counted(bytes, 0, columns);
    expect(out.Q1).toEqual([0, 2]);
    expect(out.Q4).toEqual([1]);
    expect(out.Q2).toEqual([3]);
  });
  it("takes an adjusted quadrant's arms alike", () => {
    const bytes = workbench(["D1", "D2"], [
      { id: "q", type: "quad", names: ["Q4", "Q3", "Q1", "Q2"], gate: plain, desync: { D2: { ...plain, xVertices: [100, 100, 293, 120, 0] } } },
    ], [0, 1, 2, 3].map((number) => ({ gate: "q", number, parents: ["root"] })));
    const { out } = counted(bytes, 0, columns);
    expect(out.Q1).toEqual([0, 2]);
    expect(out.Q4).toEqual([1]);
  });
});

describe("a range or rectangle on a biex axis", () => {
  // FlowJo 11 tests each bound with the event on its 4096-entry table: in where floor(lo × 16) ≤
  // entry < floor(hi × 16) (S6, 2026-10-23: a biex range on four files and a biex rectangle on four,
  // flowjo11Workbench.ts). The low bound at display 92.6143 is 0.83 of the way through entry 1481 and
  // the high one at 125.03125 half way through entry 2000: an event 0.4 of the way through entry 1481
  // is below the low bound as a value but on its entry, so in; one in entry 1480 is out; one 0.2 of
  // the way through entry 2000 is below the high bound as a value but on its entry, so out.
  const BIEX = { transformType: "Biex", T: 262144, A: 0, M: 4.5, W: -100, vectorLength: 256, autoWidthBasis: false };
  const { raw: table } = biexBreakpoints({ maxValue: 262144, pos: 4.5, neg: 0, widthBasis: -100, channelRange: 256, tableChannels: FLOWJO_BIEX_TABLE_CHANNELS });
  const at = (entry: number) => table[Math.floor(entry)] + (entry - Math.floor(entry)) * (table[Math.floor(entry) + 1] - table[Math.floor(entry)]);
  const [lo, hi] = [1481.83 / 16, 2000.5 / 16];
  const values = [at(1481.4), at(1480.5), at(1999.9), at(2000.2), at(1700)];

  it("holds a range's events by their table entries, the low entry in and the high one out", () => {
    const range = { type: "range", xAxis: axis("FL1-A", BIEX), xVertices: [lo, hi], yVertices: [64, 64] };
    const bytes = workbench(["D1"], [{ id: "r", type: "range", names: ["R"], gate: range }], [{ gate: "r", parents: ["root"] }]);
    const { out } = counted(bytes, 0, { "FL1-A": values });
    expect(out.R).toEqual([0, 2, 4]);
  });
  it("holds a rectangle biex on both axes alike", () => {
    const rect = { type: "rectangle", xAxis: axis("FL1-A", BIEX), yAxis: axis("FL2-A", BIEX), xVertices: [lo, hi], yVertices: [lo, hi] };
    const bytes = workbench(["D1"], [{ id: "r", type: "rectangle", names: ["R"], gate: rect }], [{ gate: "r", parents: ["root"] }]);
    const mid = values.map(() => at(1700));
    const { out } = counted(bytes, 0, { "FL1-A": [...values, ...mid], "FL2-A": [...mid, ...values] });
    expect(out.R).toEqual([0, 2, 4, 5, 7, 9]);
  });
  it("keeps a bound beyond the display an open edge", () => {
    const range = { type: "range", xAxis: axis("FL1-A", BIEX), xVertices: [-20, hi], yVertices: [64, 64] };
    const bytes = workbench(["D1"], [{ id: "r", type: "range", names: ["R"], gate: range }], [{ gate: "r", parents: ["root"] }]);
    const { out } = counted(bytes, 0, { "FL1-A": [-5000, ...values] });
    expect(out.R).toEqual([0, 1, 2, 3, 5]);
  });
});

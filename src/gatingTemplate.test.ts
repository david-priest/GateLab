// Gating template: a tree exported from one workspace and applied to files loaded in another holds
// the same events in every population, whatever gate kinds it uses and whatever axes the other
// workspace shows (David, 2026-11-10). Drawn and counted: every population's mask is compared
// with the source workspace's, event for event.
import { describe, it, expect } from "vitest";
import {
  buildGatingTemplate, parseGatingTemplate, planTemplateChannels, serializeGatingTemplate,
  templateCompensationFor, templateFromWorkspace, templateImportResult, type GatingTemplate,
} from "./gatingTemplate";
import { applyGatingStrategy } from "./engine/populations";
import { Sample, transformFromSpec } from "./engine/sample";
import type { FcsFile } from "./engine/fcs";
import {
  UNBOUNDED, linkChildToParent, newGateRef, newPopulation, newRootPopulation,
  type Gate, type GateRef, type PopulationMap,
} from "./engine/models";

/** A deterministic spread of events: x and y between 1 and about 1e5, some below zero. */
function events(n: number, seed: number): number[] {
  let s = seed;
  return Array.from({ length: n }, () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    const u = s / 2147483648;
    return u < 0.05 ? -200 * u * 20 : Math.pow(10, 5 * u);
  });
}

function flowFcs(names: string[], markers: (string | null)[], spillover: FcsFile["spillover"] = null): FcsFile {
  const n = 3000;
  return {
    version: "FCS3.1", nEvents: n, instrument: "flow", keywords: {}, spillover,
    channels: names.map((name, index) => ({ index, name, marker: markers[index], bits: 32, range: 262144 })),
    columns: names.map((_, i) => Float32Array.from(events(n, 17 + 31 * i))),
  };
}

function cytofFcs(markers: string[]): FcsFile {
  const n = 3000;
  const metals = ["Er170Di", "Nd142Di", "Sm149Di"];
  return {
    version: "FCS3.1", nEvents: n, instrument: "cytof", keywords: {}, spillover: null,
    channels: metals.map((name, index) => ({ index, name, marker: markers[index], bits: 32, range: 0 })),
    columns: metals.map((_, i) => Float32Array.from(events(n, 5 + 13 * i).map((v) => Math.max(0, v / 50)))),
  };
}

const FLOW = ["FSC-A", "SSC-A", "FL1-A", "FL2-A"];

/** A tree holding every gate kind, in raw and display space, with NOT refs and OR logic. */
function flowTree(sample: Sample) {
  const lg = (ch: string) => sample.transformSpec(ch);
  const d = (ch: string, raw: number) => transformFromSpec(lg(ch)).forward(raw);
  const display = { space: "display" as const, transforms: { "FL1-A": lg("FL1-A"), "FL2-A": lg("FL2-A") } };
  const base = { color: "#000", label_offset: null };
  const gates: Record<string, Gate> = {
    cells: { ...base, gate_id: "cells", name: "Cells", gate_type: "polygon", x_channel: "FSC-A", y_channel: "SSC-A", space: "raw",
      vertices: [[10, 10], [9e4, 20], [8e4, 9e4], [30, 7e4]] },
    rect: { ...base, gate_id: "rect", name: "FL1 rect", gate_type: "rectangle", x_channel: "FL1-A", y_channel: "FL2-A", space: "raw",
      vertices: [[100, 50], [2e4, 3e4]] },
    open: { ...base, gate_id: "open", name: "FL1 high", gate_type: "rectangle", x_channel: "FL1-A", y_channel: "FL2-A", space: "raw", bounds: "half-open",
      vertices: [[1000, -UNBOUNDED], [UNBOUNDED, UNBOUNDED]] },
    ell: { ...base, ...display, gate_id: "ell", name: "Ellipse", gate_type: "ellipse", x_channel: "FL1-A", y_channel: "FL2-A",
      mean: [d("FL1-A", 1000), d("FL2-A", 1000)], covariance: [[0.01, 0.002], [0.002, 0.008]], distance_square: 1 },
    quad: { ...base, ...display, gate_id: "quad", name: "Straight", gate_type: "quadrant", x_channel: "FL1-A", y_channel: "FL2-A",
      center: [d("FL1-A", 500), d("FL2-A", 800)] },
    curly: { ...base, ...display, gate_id: "curly", name: "Curly", gate_type: "quadrant", x_channel: "FL1-A", y_channel: "FL2-A",
      center: [d("FL1-A", 300), d("FL2-A", 300)], curl: { power: 1.5, kx: 0.4, ky: 0.3 } },
    spider: { ...base, gate_id: "spider", name: "Spider", gate_type: "quadrant", x_channel: "FSC-A", y_channel: "SSC-A", space: "raw",
      center: [3000, 4000], arms: { down: [2500, -1000], right: [1.2e5, 5000], up: [4000, 1.1e5], left: [-1000, 3500] } },
    // Display space with no transforms recorded: on flow its axes are read on raw values
    // (sample.ts gatingDataFor), so the template writes identity transforms into it.
    legacy: { ...base, gate_id: "legacy", name: "Legacy display", gate_type: "rectangle", x_channel: "FL2-A", y_channel: "FL1-A", space: "display",
      vertices: [[200, 50], [5000, 8000]] },
  };
  const root = newRootPopulation();
  const populations: PopulationMap = { [root.population_id]: root };
  const add = (name: string, refs: GateRef[], parent = root.population_id, logic: "and" | "or" = "and") => {
    const pop = newPopulation(name, refs, parent, logic);
    populations[pop.population_id] = pop;
    linkChildToParent(populations, pop.population_id, parent);
    return pop.population_id;
  };
  const cells = add("Cells", [newGateRef("cells")]);
  add("Rect and not ellipse", [newGateRef("rect"), newGateRef("ell", false)], cells);
  add("High or ellipse", [newGateRef("open"), newGateRef("ell")], cells, "or");
  for (const q of [1, 2, 3, 4]) add(`Straight Q${q}`, [newGateRef("quad", true, q)], cells);
  for (const q of [1, 2, 3, 4]) add(`Curly Q${q}`, [newGateRef("curly", true, q)]);
  for (const q of [1, 2, 3, 4]) add(`Spider Q${q}`, [newGateRef("spider", true, q)]);
  add("Not spider Q2", [newGateRef("spider", false, 2)]);
  add("Legacy", [newGateRef("legacy")], cells);
  return { name: "Main", gates, gate_order: Object.keys(gates), populations, root_population_id: root.population_id };
}

/** Each population's events by name. */
function masksByName(tree: { gates: Record<string, Gate>; populations: PopulationMap; root_population_id: string }, sample: Sample) {
  const { masks } = applyGatingStrategy(tree.gates, tree.populations, tree.root_population_id, sample.gateAssayData());
  return new Map(Object.values(tree.populations).map((p) => [p.name, Array.from(masks[p.population_id] ?? [])]));
}

const roundTrip = (t: GatingTemplate) => parseGatingTemplate(serializeGatingTemplate(t));

describe("a gating template applied to other files holds the same events (David, 2026-11-10)", () => {
  it("every gate kind, raw and display, NOT and OR: identical masks on the same data, and on a file shown on other axes", () => {
    const source = new Sample(flowFcs(FLOW, [null, null, null, null]));
    const tree = flowTree(source);
    const want = masksByName(tree, source);
    // Every population holds some events, so the comparison is not of empty masks.
    for (const [name, mask] of want) expect(mask.some(Boolean), name).toBe(true);
    const template = roundTrip(buildGatingTemplate({ tree, sample: source, globalScales: {}, app: "GateLab test", workspaceId: "w1", fileName: "a.fcs", files: 1 }));
    expect(template.fixed_transforms).toEqual(["Legacy display"]);

    // The same events in a new workspace, shown on other axes.
    const target = new Sample(flowFcs(FLOW, [null, null, null, null]));
    target.setLogicleW(target.index("FL1-A")!, 1.5);
    target.setLogicleW(target.index("FL2-A")!, 0.1);
    const plan = planTemplateChannels(template.channels, target.channels, target.instrument);
    expect(plan.ok).toBe(true);
    expect(plan.rows.every((r) => r.by === "key")).toBe(true);
    const res = templateImportResult(template, plan, false, target.gatingSpace);
    const got = masksByName(res, target);
    for (const [name, mask] of want) expect(got.get(name), name).toEqual(mask);
    expect(res.gates.legacy.transforms).toEqual({ "FL1-A": { kind: "identity" }, "FL2-A": { kind: "identity" } });
    // Gate kinds and geometry are as stored.
    expect(res.gates.curly).toMatchObject({ gate_type: "quadrant", curl: { power: 1.5, kx: 0.4, ky: 0.3 } });
    expect(res.gates.spider).toMatchObject({ gate_type: "quadrant", arms: tree.gates.spider.gate_type === "quadrant" ? tree.gates.spider.arms : null });
    expect(res.n_gates_imported).toBe(8);
    expect(res.n_pops_imported).toBe(Object.keys(tree.populations).length - 1);
  });

  it("maps channels whose keys differ by $PnN, and holds the same events", () => {
    // Mass cytometry keys channels by marker: the new panel names the markers otherwise, on the same metals.
    const source = new Sample(cytofFcs(["CD3", "CD8", "CD4"]));
    const display = (ch: string, v: number) => transformFromSpec(source.transformSpec(ch)).forward(v);
    const gates: Record<string, Gate> = {
      t: { gate_id: "t", name: "T cells", gate_type: "rectangle", x_channel: "CD3", y_channel: "CD8", color: "#000", label_offset: null,
        // A legacy CyTOF gate: display space at the workspace's cofactor, no transforms.
        vertices: [[display("CD3", 5), display("CD8", 1)], [display("CD3", 1e3), display("CD8", 2e3)]] },
    };
    const root = newRootPopulation();
    const populations: PopulationMap = { [root.population_id]: root };
    const pop = newPopulation("T", [newGateRef("t")], root.population_id);
    populations[pop.population_id] = pop;
    linkChildToParent(populations, pop.population_id, root.population_id);
    const tree = { name: "Main", gates, gate_order: ["t"], populations, root_population_id: root.population_id };
    const want = masksByName(tree, source);
    expect(want.get("T")!.some(Boolean)).toBe(true);
    const template = roundTrip(buildGatingTemplate({ tree, sample: source, globalScales: {}, app: "t", workspaceId: null, fileName: null, files: 1 }));

    const target = new Sample(cytofFcs(["CD3_BV", "CD8_BV", "CD4_BV"]), { cytofCofactor: 150 });
    const plan = planTemplateChannels(template.channels, target.channels, "cytof");
    expect(plan.rows.map((r) => [r.channel.key, r.target, r.by])).toEqual([["CD3", "CD3_BV", "pnn"], ["CD8", "CD8_BV", "pnn"]]);
    const res = templateImportResult(template, plan, false, target.gatingSpace);
    expect(res.gates.t.transforms).toEqual({ CD3_BV: { kind: "asinh", cofactor: 5 }, CD8_BV: { kind: "asinh", cofactor: 5 } });
    const got = masksByName(res, target);
    expect(got.get("T")).toEqual(want.get("T"));
    // Copied as stored, the gate would be read at the new workspace's cofactor and move.
    const asStored = { ...tree, gates: { t: { ...gates.t, x_channel: "CD3_BV", y_channel: "CD8_BV" } as Gate } };
    expect(masksByName(asStored, target).get("T")).not.toEqual(want.get("T"));
  });

  it("refuses a channel it cannot find, one found twice, and two found on one", () => {
    const channels = [
      { key: "CD3", pnn: "Er170Di", marker: "CD3" },
      { key: "CD8", pnn: "Nd142Di", marker: "CD8" },
      { key: "CD4", pnn: "Sm149Di", marker: "CD4" },
    ];
    const target = [
      { key: "CD3 (Yb171Di)", pnn: "Yb171Di", marker: "CD3" },
      { key: "CD3 (Yb172Di)", pnn: "Yb172Di", marker: "CD3" },
      { key: "CD8a", pnn: "Nd142Di", marker: "CD8a" },
      { key: "CD4a", pnn: "Lu175Di", marker: "CD4" },
    ];
    const plan = planTemplateChannels(channels, target, "cytof");
    expect(plan.ok).toBe(false);
    expect(plan.rows.map((r) => [r.channel.key, r.target, r.problem])).toEqual([
      ["CD3", null, "ambiguous"], ["CD8", "CD8a", null], ["CD4", "CD4a", null],
    ]);
    expect(planTemplateChannels(channels.slice(0, 1), target.slice(2), "cytof").rows[0].problem).toBe("missing");
    // Picked by hand, two template channels on one loaded channel are both refused.
    const shared = planTemplateChannels(channels.slice(1), target, "cytof", { CD8: "CD4a" });
    expect(shared.rows.map((r) => r.problem)).toEqual(["shared", "shared"]);
    // Picked by hand, the ambiguous one is taken.
    const picked = planTemplateChannels(channels, target, "cytof", { CD3: "CD3 (Yb172Di)" });
    expect(picked.ok).toBe(true);
    expect(picked.rows[0]).toMatchObject({ target: "CD3 (Yb172Di)", by: "manual" });
    expect(() => templateImportResult({ channels } as unknown as GatingTemplate, plan, false, "raw")).toThrow(/Every channel/);
  });

  it("reads a saved workspace as a template, taking the tree a file's tailored copy follows", () => {
    const source = new Sample(flowFcs(FLOW, [null, null, null, null]));
    const tree = flowTree(source);
    const want = masksByName(tree, source);
    // The workspace was saved viewing a file's tailored copy, whose Cells gate is moved.
    const copyGates = { ...tree.gates, cells: { ...tree.gates.cells, vertices: [[1, 1], [2, 1], [2, 2]] } as Gate };
    const workspace = {
      format: "gatelab-workspace", version: 2, savedAt: "", app: "GateLab test", workspaceId: "w2", activeSample: 0,
      samples: [{ fileName: "a.fcs", dataPath: "data/0_a.fcs", logicleW: {}, compensationOn: false }],
      gating: {
        gates: copyGates, gate_order: tree.gate_order, populations: tree.populations, root_population_id: tree.root_population_id,
        active_population_id: null, selected_gate_id: null,
        hierarchies: [
          { id: "main", name: "Main" },
          { id: "copy", name: "Main", owner_sample_id: "s1", structure_locked: true, source_hierarchy_id: "main" },
        ],
        active_hierarchy_id: "copy",
        stored_hierarchies: [{ id: "main", name: "Main", gates: tree.gates, gate_order: tree.gate_order, populations: tree.populations, root_population_id: tree.root_population_id, active_population_id: null }],
      },
      scales: { globalScales: {} },
    };
    const template = templateFromWorkspace(workspace, null, "old.gatelab");
    expect(template.tree.gates.cells).toEqual({ ...tree.gates.cells, space: "raw" });
    // Saved by reference with compensation off, the workspace does not say its instrument: the
    // legacy gate's space is stated when it is applied, as a flow file reads it.
    expect(template.fixed_transforms).toEqual([]);
    expect(template.notes).toEqual(["Axis scales are not carried from a workspace file; the files keep their own."]);
    const target = new Sample(flowFcs(FLOW, [null, null, null, null]));
    const plan = planTemplateChannels(template.channels, target.channels, "flow");
    expect(plan.ok).toBe(true);
    const res = templateImportResult(template, plan, false, target.gatingSpace);
    expect(res.fixed_at_apply).toEqual(["Legacy display"]);
    const got = masksByName(res, target);
    for (const [name, mask] of want) expect(got.get(name), name).toEqual(mask);
  });

  it("offers the template's matrix only where the file's own differs, or the file has none", () => {
    const spill = (k: number): FcsFile["spillover"] => ({ channels: ["FL1-A", "FL2-A"], matrix: [[1, k], [0.02, 1]] });
    const source = new Sample(flowFcs(FLOW, [null, null, null, null], spill(0.1)));
    source.setCompensation(true);
    const tree = flowTree(source);
    const template = roundTrip(buildGatingTemplate({ tree, sample: source, globalScales: {}, app: "t", workspaceId: null, fileName: "a.fcs", files: 1 }));
    expect(template.compensation).toMatchObject({ enabled: true, origin: "fcs", matrix: { channels: ["FL1-A", "FL2-A"] } });
    expect(templateCompensationFor(template, new Sample(flowFcs(FLOW, [null, null, null, null], spill(0.1))))).toEqual({ target: true, offer: null, unavailable: false });
    const differs = templateCompensationFor(template, new Sample(flowFcs(FLOW, [null, null, null, null], spill(0.3))));
    expect(differs.target).toBe(true);
    expect(differs.offer).toMatchObject({ differsFromEmbedded: true, replacesEmbedded: true });
    expect(differs.offer!.maxDelta).toBeCloseTo(0.2, 6);
    const none = templateCompensationFor(template, new Sample(flowFcs(FLOW, [null, null, null, null])));
    expect(none.offer).toMatchObject({ differsFromEmbedded: false, replacesEmbedded: false });
  });

  it("refuses a file that is not a template, and a newer version", () => {
    expect(() => parseGatingTemplate("{}")).toThrow(/Not a GateLab gating template/);
    expect(() => parseGatingTemplate(JSON.stringify({ format: "gatelab-gating-template", version: 2 }))).toThrow(/version 2/);
    expect(() => parseGatingTemplate(JSON.stringify({ format: "gatelab-gating-template", version: 1, tree: { gates: {}, gate_order: ["x"], populations: { r: { gate_refs: [] } }, root_population_id: "r" } })))
      .toThrow(/gate order names a gate/);
  });
});

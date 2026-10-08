import { describe, it, expect } from "vitest";
import { computeMultiPopStrategy, buildMultiStrategyPayload, flowLayout, tidyLayout } from "./multiStrategy";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";
import type { Gate, Population, PopulationMap, GateRef } from "./models";

// ── A tiny, deterministic flow Sample ────────────────────────────────────────
// Channel names are all QC channels → identity transforms (gating space == display
// space, no logicle sorting), so the layout maths is easy to reason about. Only
// index()/displayColumn()/displayRange()/gatingToDisplay()/labelForKey()/channelTicks()
// are exercised by the layout code under test.
function makeSample(nEvents = 10): Sample {
  const names = ["Center", "Offset", "Residual", "Width"];
  const columns = names.map((_, j) => Float32Array.from({ length: nEvents }, (_, i) => i + j));
  const channels = names.map((name, index) => ({ index, name, marker: null, bits: 32, range: 1024 }));
  const fcs: FcsFile = {
    version: "FCS3.1",
    nEvents,
    channels,
    keywords: {},
    columns,
    spillover: null,
    instrument: "flow",
  };
  return new Sample(fcs);
}

const ref = (gateId: string, include = true): GateRef => ({ gate_id: gateId, include });

const pop = (
  id: string,
  name: string,
  parent: string | null,
  children: string[],
  gateRefs: GateRef[] = [],
): Population => ({
  population_id: id,
  name,
  gate_refs: gateRefs,
  gate_logic: "and",
  parent_id: parent,
  children,
  event_count: null,
  percent_of_parent: null,
});

const rect = (id: string, xCh: string, yCh: string): Gate => ({
  gate_id: id,
  name: id,
  gate_type: "rectangle",
  x_channel: xCh,
  y_channel: yCh,
  vertices: [
    [0, 0],
    [9, 9],
  ],
  color: "#ff0000",
  label_offset: null,
});

// Tree:  root ─ P(gP) ─┬─ C1(gC1 on Center/Offset)
//                      └─ C2(gC2 on Residual/Width)   ← different channel pair
function makeTree(): { pops: PopulationMap; gates: Record<string, Gate> } {
  const pops: PopulationMap = {
    root: pop("root", "All", null, ["P"]),
    P: pop("P", "P", "root", ["C1", "C2"], [ref("gP")]),
    C1: pop("C1", "C1", "P", [], [ref("gC1")]),
    C2: pop("C2", "C2", "P", [], [ref("gC2")]),
  };
  const gates: Record<string, Gate> = {
    gP: rect("gP", "Center", "Offset"),
    gC1: rect("gC1", "Center", "Offset"),
    gC2: rect("gC2", "Residual", "Width"),
  };
  return { pops, gates };
}

// masks[P] keeps the first 5 events (root is all-true internally).
const MASKS: Record<string, Uint8Array> = {
  root: Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
  P: Uint8Array.from([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]),
  C1: Uint8Array.from([1, 1, 1, 0, 0, 0, 0, 0, 0, 0]),
  C2: Uint8Array.from([0, 0, 0, 1, 1, 0, 0, 0, 0, 0]),
};

const OPTS = { maxEvents: 10000, globalScales: {} as Record<string, [number, number]> };

describe("computeMultiPopStrategy — selecting a leaf pulls in its ancestors (chain)", () => {
  const sample = makeSample();
  const { pops, gates } = makeTree();
  const nodes = computeMultiPopStrategy(sample, gates, pops, "root", MASKS, ["C1"], OPTS);

  it("produces one node per ancestor gate step (root→P→C1 = 2 nodes)", () => {
    expect(nodes.length).toBe(2);
    expect(new Set(nodes.map((n) => n.parent_pop_id))).toEqual(new Set(["root", "P"]));
  });

  it("col = gate depth of the parent; both share row 0", () => {
    const byParent = Object.fromEntries(nodes.map((n) => [n.parent_pop_id, n]));
    expect(byParent.root.col).toBe(0); // P's gate is drawn on root events
    expect(byParent.P.col).toBe(1); // C1's gate is drawn on P events (1 gate deep)
    expect(byParent.root.row).toBe(0);
    expect(byParent.P.row).toBe(0);
  });

  it("n_events uses the parent mask counts (root=all, P=5)", () => {
    const byParent = Object.fromEntries(nodes.map((n) => [n.parent_pop_id, n]));
    expect(byParent.root.n_events).toBe(10);
    expect(byParent.P.n_events).toBe(5);
  });

  it("axis labels are display labels; ranges/vertices are populated", () => {
    const pNode = nodes.find((n) => n.parent_pop_id === "P")!;
    expect(pNode.x_channel).toBe("Center");
    expect(pNode.y_channel).toBe("Offset");
    expect(pNode.x.length).toBe(5); // 5 parent events plotted
    expect(pNode.gates.length).toBe(1);
    expect(pNode.gates[0].vertices.length).toBeGreaterThanOrEqual(4); // rectangle → AABB corners
    expect(pNode.node_id).toBe("P|Center|Offset");
  });
});

describe("computeMultiPopStrategy — branch: two children on different channels at one parent", () => {
  const sample = makeSample();
  const { pops, gates } = makeTree();
  const nodes = computeMultiPopStrategy(sample, gates, pops, "root", MASKS, ["C1", "C2"], OPTS);

  it("produces 3 nodes (P-gate-on-root + C1-on-P + C2-on-P)", () => {
    expect(nodes.length).toBe(3);
    expect(new Set(nodes.map((n) => n.node_id))).toEqual(
      new Set(["root|Center|Offset", "P|Center|Offset", "P|Residual|Width"]),
    );
  });

  it("collision resolver bumps the second same-(row,col) node's col", () => {
    const byId = Object.fromEntries(nodes.map((n) => [n.node_id, n]));
    // root step at col 0; the two P-parent nodes would both be (row 0, col 1) →
    // resolver keeps the first (node_id order) at col 1 and bumps the other to col 2.
    expect(byId["root|Center|Offset"].col).toBe(0);
    expect(byId["P|Center|Offset"].col).toBe(1);
    expect(byId["P|Residual|Width"].col).toBe(2);
  });

  it("every node lands on a distinct (row, col) cell, all in row 0", () => {
    nodes.forEach((n) => expect(n.row).toBe(0));
    const coords = nodes.map((n) => `${n.row}|${n.col}`);
    expect(new Set(coords).size).toBe(3);
  });
});

describe("computeMultiPopStrategy — edge cases", () => {
  it("returns [] when nothing is selected", () => {
    const sample = makeSample();
    const { pops, gates } = makeTree();
    expect(computeMultiPopStrategy(sample, gates, pops, "root", MASKS, [], OPTS)).toEqual([]);
  });

  it("downsamples parent events to maxEvents", () => {
    const sample = makeSample();
    const { pops, gates } = makeTree();
    const nodes = computeMultiPopStrategy(sample, gates, pops, "root", MASKS, ["C1"], {
      maxEvents: 3,
      globalScales: {},
    });
    const rootNode = nodes.find((n) => n.parent_pop_id === "root")!;
    expect(rootNode.n_events).toBe(10); // reported count is the true size
    expect(rootNode.x.length).toBe(3); // plotted array is downsampled
  });
});

describe("buildMultiStrategyPayload", () => {
  it("wraps nodes with the render options and style keys GateLab uses", () => {
    const sample = makeSample();
    const { pops, gates } = makeTree();
    const nodes = computeMultiPopStrategy(sample, gates, pops, "root", MASKS, ["C1", "C2"], OPTS);
    const payload = buildMultiStrategyPayload(nodes, {
      displayMode: "pseudocolor",
      plotSize: 200,
      contourThreshold: 5,
      pointAlpha: 0.35,
      densityColorPower: 1.6,
      pointSize: 1.2,
      kdeBandwidth: 0,
      pubStyle: false,
      gateLineWidth: 1.5,
      fontSizes: { tick: 8, axis_label: 10, gate_label: 8, title: 10 },
      contextTitle: "2 populations",
    }) as Record<string, unknown>;

    expect(payload.containerId).toBe("strategy-grid-container");
    expect((payload.nodes as unknown[]).length).toBe(3);
    expect(payload.display_mode).toBe("pseudocolor");
    expect(payload.density_color_power).toBe(1.6);
    expect(payload.plot_size).toBe(200);
    expect(payload.strategy_context_title).toBe("2 populations");
    expect(payload.strategy_context_title_font).toBe(11); // title(10) + 1
    expect(payload.gate_style).toEqual({
      pub_style: false, line_width: 1.5, gate_edge_mode: "straight-bow", label_format: "name-percent",
    });
  });
});

describe("flowLayout — the tree walked depth first and wrapped into rows", () => {
  const sample = makeSample();
  const { pops, gates } = makeTree();
  const nodes = computeMultiPopStrategy(sample, gates, pops, "root", MASKS, ["C1", "C2"], OPTS);

  it("puts the root's panel first, then the panels its gate leads to, in rows of the given width", () => {
    const laid = flowLayout(nodes, 2, pops);
    expect(laid.map((n) => n.node_id)).toEqual(["root|Center|Offset", "P|Center|Offset", "P|Residual|Width"]);
    expect(laid.map((n) => [n.row, n.col])).toEqual([[0, 0], [0, 1], [1, 0]]);
    // The input is left as it was.
    expect(Object.fromEntries(nodes.map((n) => [n.node_id, n.col]))).toEqual({ "root|Center|Offset": 0, "P|Center|Offset": 1, "P|Residual|Width": 2 });
  });

  it("holds a width of at least one, and keeps every panel", () => {
    expect(flowLayout(nodes, 0, pops).map((n) => [n.row, n.col])).toEqual([[0, 0], [1, 0], [2, 0]]);
    expect(flowLayout([], 3, pops)).toEqual([]);
  });
});

describe("tidyLayout — a column per depth, a row per leaf, a second channel pair stacked", () => {
  const sample = makeSample();
  const { pops, gates } = makeTree();
  const nodes = computeMultiPopStrategy(sample, gates, pops, "root", MASKS, ["C1", "C2"], OPTS);

  it("stacks the two panels of P under one column, below the root's row", () => {
    const laid = tidyLayout(nodes, pops);
    const at = Object.fromEntries(laid.map((n) => [n.node_id, [n.row, n.col]]));
    expect(at["root|Center|Offset"]).toEqual([0, 0]);
    // Both P panels are the root's gate's children: the first shares the root's row, the
    // second goes below it in the same column — not bumped to a column of its own.
    expect(at["P|Center|Offset"]).toEqual([0, 1]);
    expect(at["P|Residual|Width"]).toEqual([1, 1]);
    expect(nodes.find((n) => n.node_id === "P|Residual|Width")!.col).toBe(2); // the input is left alone
  });

  it("gives every panel a cell of its own", () => {
    const laid = tidyLayout(nodes, pops);
    expect(new Set(laid.map((n) => `${n.row}|${n.col}`)).size).toBe(laid.length);
    expect(tidyLayout([], pops)).toEqual([]);
  });
});

describe("tidyLayout — branches that each lead on", () => {
  // The layout reads a panel's population and its gates, nothing else.
  const panel = (pop: string, gateIds: string[]) =>
    ({ node_id: `${pop}|x|y`, parent_pop_id: pop, gates: gateIds.map((gate_id) => ({ gate_id })), row: 0, col: 0 }) as unknown as Parameters<typeof tidyLayout>[0][number];
  const child = (parent: string, gate: string) => ({ parent_id: parent, gate_refs: [{ gate_id: gate }] });
  const places = (laid: ReturnType<typeof tidyLayout>) => Object.fromEntries(laid.map((n) => [n.parent_pop_id, [n.row, n.col]]));

  // Reported with T and B cell populations traced together: every subtree was counted as one
  // row tall, so the second branch was put in the rows the first branch's children already held.
  it("puts a second branch below everything the first holds in the columns they share", () => {
    const pops = {
      root: { parent_id: null, gate_refs: [] },
      t: child("root", "gT"), b: child("root", "gB"),
      t1: child("t", "gT1"), t2: child("t", "gT2"), b1: child("b", "gB1"),
      t1x: child("t1", "gT1x"), t2x: child("t2", "gT2x"), b1x: child("b1", "gB1x"),
    };
    const laid = tidyLayout([
      panel("root", ["gT", "gB"]), panel("t", ["gT1", "gT2"]), panel("b", ["gB1"]),
      panel("t1", ["gT1x"]), panel("t2", ["gT2x"]), panel("b1", ["gB1x"]),
    ], pops);
    expect(places(laid)).toEqual({
      root: [0, 0],
      t: [0, 1], t1: [0, 2], t2: [1, 2],
      // Not row 1, where t2 already is in the next column.
      b: [2, 1], b1: [2, 2],
    });
    expect(new Set(laid.map((n) => `${n.row}|${n.col}`)).size).toBe(laid.length);
  });

  it("tucks a later child that leads nowhere under its sibling, beside that sibling's children", () => {
    const pops = {
      root: { parent_id: null, gate_refs: [] },
      t: child("root", "gT"), leaf: child("root", "gLeaf"),
      t1: child("t", "gT1"), t2: child("t", "gT2"), t3: child("t", "gT3"),
      t1x: child("t1", "g1"), t2x: child("t2", "g2"), t3x: child("t3", "g3"), leafx: child("leaf", "g4"),
    };
    const laid = tidyLayout([
      panel("root", ["gT", "gLeaf"]), panel("t", ["gT1", "gT2", "gT3"]), panel("leaf", ["g4"]),
      panel("t1", ["g1"]), panel("t2", ["g2"]), panel("t3", ["g3"]),
    ], pops);
    expect(places(laid)).toEqual({
      root: [0, 0],
      t: [0, 1], t1: [0, 2], t2: [1, 2], t3: [2, 2],
      // Row 1 of its own column is free: three rows in all, not four.
      leaf: [1, 1],
    });
  });

  it("gives a panel that two panels lead to to the first of them, and each panel a cell of its own", () => {
    const pops = {
      root: { parent_id: null, gate_refs: [] },
      p: child("root", "gP"),
      // Made by a gate on each of p's two panels: two ways in.
      c: { parent_id: "p", gate_refs: [{ gate_id: "g1" }, { gate_id: "g2" }] },
      cx: child("c", "gC"),
    };
    const second = { ...panel("p", ["g2"]), node_id: "p|u|v" };
    const laid = tidyLayout([panel("root", ["gP"]), panel("p", ["g1"]), second, panel("c", ["gC"])], pops);
    expect(Object.fromEntries(laid.map((n) => [n.node_id, [n.row, n.col]]))).toEqual({
      "root|x|y": [0, 0], "p|x|y": [0, 1], "c|x|y": [0, 2], "p|u|v": [1, 1],
    });
  });

  it("starts a second root below the first root's own column", () => {
    const pops = {
      r1: { parent_id: null, gate_refs: [] }, r2: { parent_id: null, gate_refs: [] },
      a: child("r1", "gA"), b: child("r1", "gB"), c: child("r2", "gC"),
      ax: child("a", "g1"), bx: child("b", "g2"), cx: child("c", "g3"),
    };
    const laid = tidyLayout([panel("r1", ["gA", "gB"]), panel("r2", ["gC"]), panel("a", ["g1"]), panel("b", ["g2"]), panel("c", ["g3"])], pops);
    expect(places(laid)).toEqual({ r1: [0, 0], a: [0, 1], b: [1, 1], r2: [2, 0], c: [2, 1] });
  });
});

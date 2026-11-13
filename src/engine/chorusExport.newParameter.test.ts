// @vitest-environment jsdom
// A new gate written to a .cef on a channel the source experiment does not use: the parameter
// objects built for it, the gate's colour, and the signs of its vertices.
import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { cefBytes } from "./chorusExperiment.test";
import { chorusToGatingML, readChorusExperiment } from "./chorusExperiment";
import { exportChorusExperiment, type ChorusExportChannel } from "./chorusExport";
import { importGatingML } from "./gatingml";
import type { Gate, PolyRectGate, PopulationMap } from "./models";

const CHANNELS = ["Time", "FSC-A", "FSC-H", "FSC-W", "SSC (Imaging)-A", "SSC (Imaging)-H", "BUV805-A", "BV421-A", "PE-A", "BV711-A", "Max Intensity (SSC (Imaging))"];
const channels: ChorusExportChannel[] = CHANNELS.map((c) => ({ key: c, pnn: c }));
const kw: Record<string, string> = { $PAR: String(CHANNELS.length) };
CHANNELS.forEach((name, i) => { kw[`$P${i + 1}N`] = name; kw[`$P${i + 1}R`] = "262144"; });

type JGate = { name: string; children: { name: string; color: string }[]; vertices: { x: number; y: number }[]; parameters: Record<string, unknown>[] };
const gatesOf = (bytes: Uint8Array): JGate[] => JSON.parse(strFromU8(unzipSync(bytes)["experiment.json"])).experiment.panels[0].analysis.gates;

/** The source's tree as GateLab reads it, or a bare root for a source with no gates. */
function treeOf(source: Uint8Array, k: Record<string, string>): { gates: Record<string, Gate>; populations: PopulationMap; root_population_id: string } {
  if (readChorusExperiment(source).panels[0].gates.length === 0) {
    return { gates: {}, populations: { root: { population_id: "root", name: "All Events", gate_refs: [], gate_logic: "and", parent_id: null, children: [], event_count: null, percent_of_parent: null } }, root_population_id: "root" };
  }
  return importGatingML(chorusToGatingML(readChorusExperiment(source), 0, { keywords: k }).gatingMl, CHANNELS, {}, "flow");
}

/** The source's tree with one new rectangle under the root, on SSC (Imaging)-H and FSC-A. */
function exportWithNew(source: Uint8Array, vertices: [number, number][], color: string) {
  const tree = treeOf(source, kw);
  const root = tree.populations[tree.root_population_id];
  const gate: PolyRectGate = { gate_id: "new-1", name: "S1", gate_type: "rectangle", x_channel: "SSC (Imaging)-H", y_channel: "FSC-A", vertices, color, label_offset: null };
  const gates: Record<string, Gate> = { ...tree.gates, "new-1": gate };
  const populations: PopulationMap = {
    ...tree.populations,
    "pop-new": { population_id: "pop-new", name: "S1", gate_refs: [{ gate_id: "new-1", include: true }], gate_logic: "and", parent_id: root.population_id, children: [], event_count: null, percent_of_parent: null },
  };
  populations[root.population_id] = { ...root, children: [...root.children, "pop-new"] };
  const result = exportChorusExperiment({ source, channels, keywords: kw, gates, populations, root_population_id: tree.root_population_id });
  return { result, written: gatesOf(result.bytes).find((g) => g.children[0]?.name === "S1")! };
}

describe("a new Chorus gate on a channel the source does not use", () => {
  it("builds a scatter parameter named by the channel's first word, of kind Scatter", () => {
    const { written } = exportWithNew(cefBytes(), [[100, 200], [5000, 6000]], "#000000");
    expect(written.parameters[0]).toEqual({
      measurementId: "SSC (Imaging)", fluorochrome: "SSC", measurement: "H", scatter: "SSC", scale: "Linear",
      numerator: null, denominator: null, parameterKind: "Scatter",
    });
  });

  it("writes every colour component, blue included", () => {
    const { written } = exportWithNew(cefBytes(), [[100, 200], [5000, 6000]], "#1020ff");
    expect(written.children[0].color).toBe("16,32,255");
  });

  it("keeps a vertex at -1 and writes -0 as 0", () => {
    const { result, written } = exportWithNew(cefBytes(), [[-1, -0], [5000, 6000]], "#000000");
    expect(written.vertices).toEqual([{ x: -1, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 6000 }, { x: -1, y: 6000 }]);
    expect(strFromU8(unzipSync(result.bytes)["experiment.json"])).not.toContain("-0.0");
  });

  it("keeps a built key the source's parameter objects do not carry", () => {
    // A source whose one gate's parameters lack "scatter": the template then orders the known keys
    // and the rest follow.
    const p = (name: string) => ({ measurementId: name, fluorochrome: name, measurement: "A", scale: "Linear", parameterKind: "Scatter" });
    const doc = {
      experiment: { panels: [{ name: "Panel 1", analysis: { gates: [
        { children: [{ name: "D1", color: "0,0,255", populationId: "1-1" }], inputPopulationIds: null, parameters: [p("FSC"), p("SSC (Imaging)")],
          vertices: [{ x: 1, y: 1 }, { x: 9, y: 1 }, { x: 9, y: 9 }], gateKind: "Polygon", name: "D1", gateId: "1", parentPopulationId: "0-1", categories: [] },
      ], analysisWorksheets: [] } }] },
      sortRecords: [], fluorochromes: [],
    };
    const source = zipSync({
      "manifest.json": strToU8(JSON.stringify({ version: "1.0.0", chorusVersion: "5.4.0", experimentName: "synthetic" })),
      "experiment.json": strToU8(JSON.stringify(doc, null, 2)),
      "instrument.json": strToU8("{}"),
      verification: strToU8("0000"),
    });
    const { written } = exportWithNew(source, [[100, 200], [5000, 6000]], "#000000");
    expect(written.parameters[0].scatter).toBe("SSC");
  });
});

/** A one-panel .cef holding `gates` (Chorus JSON gate objects). */
function cefOf(gates: unknown[]): Uint8Array {
  const doc = { experiment: { panels: [{ name: "Panel 1", analysis: { gates, analysisWorksheets: [] } }] }, sortRecords: [], fluorochromes: [] };
  return zipSync({
    "manifest.json": strToU8(JSON.stringify({ version: "1.0.0", chorusVersion: "5.4.0", experimentName: "synthetic" })),
    "experiment.json": strToU8(JSON.stringify(doc, null, 2)),
    "instrument.json": strToU8("{}"),
    verification: strToU8("0000"),
  });
}
const sp = (name: string, meas: string | null, kind: string, scale = "Linear") => ({ measurementId: name, fluorochrome: name.split(" ")[0], measurement: meas, scatter: name, scale, numerator: null, denominator: null, parameterKind: kind });
const jgate = (id: string, name: string, params: unknown[]) => ({
  children: [{ name, color: "0,0,255", populationId: `${id}-1` }], inputPopulationIds: null, parameters: params,
  vertices: [{ x: 1, y: 1 }, { x: 9, y: 1 }, { x: 9, y: 9 }], gateKind: "Polygon", name, gateId: id, parentPopulationId: "0-1", categories: [],
});

describe("a new Chorus gate against a source of a different shape", () => {
  it("gives a scatter parameter kind Scatter even where the source's first parameter is an image feature", () => {
    const source = cefOf([jgate("1", "D1", [sp("Max Intensity (SSC (Imaging))", null, "Max Intensity", "Log"), sp("FSC", "A", "Scatter")])]);
    const { written } = exportWithNew(source, [[100, 200], [5000, 6000]], "#000000");
    expect(written.parameters[0].parameterKind).toBe("Scatter");
  });

  it("reuses the first source parameter object of a channel when two gates use it differently", () => {
    const source = cefOf([
      jgate("1", "D1", [sp("SSC (Imaging)", "H", "Scatter", "Linear"), sp("FSC", "A", "Scatter")]),
      jgate("2", "D2", [sp("SSC (Imaging)", "H", "Scatter", "Log"), sp("FSC", "A", "Scatter")]),
    ]);
    const { written } = exportWithNew(source, [[100, 200], [5000, 6000]], "#000000");
    expect(written.parameters[0].scale).toBe("Linear");
  });

  it("numbers the first gate of a source with none 1, and counts what it wrote", () => {
    const { result } = exportWithNew(cefOf([]), [[100, 200], [5000, 6000]], "#000000");
    const all = JSON.parse(strFromU8(unzipSync(result.bytes)["experiment.json"])).experiment.panels[0].analysis.gates as { gateId: string }[];
    expect(all.map((g) => g.gateId)).toEqual(["1"]);
    expect(result.written).toBe(1);
  });
});

describe("a quadrant's outer corners from the axis window", () => {
  // x on Time ($P1), y on the image feature ($P11, the last parameter).
  const quadrantQ2 = (kwq: Record<string, string>) => {
    const source = cefOf([]);
    const tree = treeOf(source, kwq);
    const root = tree.populations[tree.root_population_id];
    const q: Gate = { gate_id: "q", name: "Q", gate_type: "quadrant", x_channel: "Time", y_channel: "Max Intensity (SSC (Imaging))", center: [100, 50], color: "#000000", label_offset: null } as unknown as Gate;
    const populations: PopulationMap = { ...tree.populations, q2: { population_id: "q2", name: "Q2", gate_refs: [{ gate_id: "q", include: true, quadrant: 2 }], gate_logic: "and", parent_id: root.population_id, children: [], event_count: null, percent_of_parent: null } };
    populations[root.population_id] = { ...root, children: [...root.children, "q2"] };
    const result = exportChorusExperiment({ source, channels, keywords: kwq, gates: { ...tree.gates, q }, populations, root_population_id: tree.root_population_id });
    return gatesOf(result.bytes).find((g) => g.children[0]?.name === "Q2")!.vertices;
  };
  const base = (): Record<string, string> => {
    const k: Record<string, string> = { $PAR: String(CHANNELS.length) };
    CHANNELS.forEach((name, i) => { k[`$P${i + 1}N`] = name; k[`$P${i + 1}R`] = "262144"; });
    return k;
  };

  it("takes each axis's $PnR where the file gives no display window", () => {
    const k = base();
    k.$P1R = "1000";
    k.$P11R = "500";
    expect(quadrantQ2(k)).toEqual([{ x: 100, y: 50 }, { x: 1000, y: 50 }, { x: 1000, y: 500 }, { x: 100, y: 500 }]);
  });

  it("takes the display window where both ends are given, and $PnR where only one is", () => {
    const k = base();
    k.$P1R = "1000";
    k.P1MDMin = "-10";
    k.P1MDMax = "800";
    k.$P11R = "500";
    k.P11MDMin = "-5";
    expect(quadrantQ2(k)).toEqual([{ x: 100, y: 50 }, { x: 800, y: 50 }, { x: 800, y: 500 }, { x: 100, y: 500 }]);
  });
});

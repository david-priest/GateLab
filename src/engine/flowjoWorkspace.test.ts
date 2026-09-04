// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isFlowJoWorkspace,
  listFlowJoWorkspaceSamples,
  flowJoWorkspaceToGatingML,
  WSP_GATE_SPACE_TAG,
} from "./flowjoWorkspace";
import { transformFromSpec } from "./sample";
import type { TransformSpec } from "./models";
import { importGatingML } from "./gatingml";

const WSP = "/Users/davidpriest/My Drive (davidpriest@cider.osaka-u.ac.jp)/Wing Lab/Large Projects/GateLab Paper/GateLab-2026-08-15-B flowjo-and-cytobank-concordance/data/lp4-igcb-s8/source/flowjo-workspace/17-Dec-2025 new.wsp";
const has = existsSync(WSP);
const wsp = () => readFileSync(WSP, "utf-8");
const lp4Index = () =>
  listFlowJoWorkspaceSamples(wsp()).find((s) => s.name === "LP4 rec.fcs")!.index;

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";

/** A minimal workspace in the shape FlowJo writes, for the cases the real file cannot show. */
function synthetic(populations: string): string {
  return `<Workspace><SampleList><SampleNode name="s.fcs" count="100"><Subpopulations>
    ${populations}
  </Subpopulations></SampleNode></SampleList></Workspace>`;
}
function polygonPop(name: string, id: string, inner = ""): string {
  return `<Population name="${name}" count="10"><Gate>
    <gating:PolygonGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="${id}">
      <gating:dimension><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
      <gating:dimension><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
      <gating:vertex><gating:coordinate data-type:value="0"/><gating:coordinate data-type:value="0"/></gating:vertex>
      <gating:vertex><gating:coordinate data-type:value="10"/><gating:coordinate data-type:value="0"/></gating:vertex>
      <gating:vertex><gating:coordinate data-type:value="10"/><gating:coordinate data-type:value="10"/></gating:vertex>
    </gating:PolygonGate></Gate>
    ${inner ? `<Subpopulations>${inner}</Subpopulations>` : ""}
  </Population>`;
}

describe("FlowJo workspace import", () => {
  it("recognises a workspace and rejects a plain Gating-ML file", () => {
    expect(isFlowJoWorkspace(synthetic(polygonPop("A", "g1")))).toBe(true);
    expect(isFlowJoWorkspace(`<gating:Gating-ML xmlns:gating="${G}"/>`)).toBe(false);
    expect(isFlowJoWorkspace("not xml at all <<<")).toBe(false);
  });

  it("carries names and nesting into the emitted Gating-ML", () => {
    const xml = synthetic(polygonPop("Parent", "g1", polygonPop("Child", "g2")));
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.gatingMl).toContain('gating:name="Parent"');
    expect(out.gatingMl).toContain('gating:name="Child"');
    expect(out.gatingMl).toContain('gating:parent_id="g1"');
    expect(out.flowJoCounts).toEqual({ Parent: 10, Child: 10 });
  });

  // An unreadable gate invalidates everything below it: those populations are defined as
  // subsets of it, so re-parenting them would silently change what they mean.
  it("skips an unsupported gate together with its descendants, and says so", () => {
    const child = polygonPop("UnderEllipse", "g2");
    const xml = synthetic(
      `<Population name="Ellipsoid" count="9"><Gate>
         <gating:EllipsoidGate xmlns:gating="${G}" gating:id="g1"/></Gate>
         <Subpopulations>${child}</Subpopulations></Population>` + polygonPop("Fine", "g3"),
    );
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.gatingMl).toContain('gating:name="Fine"');
    expect(out.gatingMl).not.toContain("UnderEllipse");
    expect(out.warnings.join(" ")).toMatch(/EllipsoidGate/);
    expect(out.warnings.join(" ")).toMatch(/skipped/);
  });

  it("reports how many samples there are when the index is out of range", () => {
    expect(() => flowJoWorkspaceToGatingML(synthetic(polygonPop("A", "g1")), 3))
      .toThrow(/holds 1/);
  });

  // FlowJo allows the same file to be added twice. Selecting by name would resolve to
  // whichever came first and import the wrong sample's gates without saying anything.
  it("distinguishes samples that share a name, and selects by position", () => {
    const two = `<Workspace><SampleList>
      <SampleNode name="dup.fcs" count="100"><Subpopulations>${polygonPop("First", "g1")}</Subpopulations></SampleNode>
      <SampleNode name="dup.fcs" count="200"><Subpopulations>${polygonPop("Second", "g2")}</Subpopulations></SampleNode>
    </SampleList></Workspace>`;
    const listed = listFlowJoWorkspaceSamples(two);
    expect(listed.map((s) => s.index)).toEqual([0, 1]);
    expect(listed.every((s) => s.duplicateName)).toBe(true);
    expect(flowJoWorkspaceToGatingML(two, 0).gatingMl).toContain('gating:name="First"');
    expect(flowJoWorkspaceToGatingML(two, 1).gatingMl).toContain('gating:name="Second"');
  });

  // Two independent top-level trees mean the sample was gated under more than one strategy;
  // importing them together is a merge the user did not ask for, so it must be stated.
  it("reports parallel gating trees rather than merging them silently", () => {
    const xml = synthetic(polygonPop("TreeA", "g1") + polygonPop("TreeB", "g2"));
    expect(listFlowJoWorkspaceSamples(xml)[0].rootCount).toBe(2);
    expect(flowJoWorkspaceToGatingML(xml, 0).warnings.join(" "))
      .toMatch(/2 independent gating trees/);
  });

  it("carries the owning group through for telling similar names apart", () => {
    const xml = `<Workspace><SampleList><SampleNode name="a.fcs" count="1" owningGroup="Panel A">
      <Subpopulations>${polygonPop("P", "g1")}</Subpopulations></SampleNode></SampleList></Workspace>`;
    expect(listFlowJoWorkspaceSamples(xml)[0].owningGroup).toBe("Panel A");
  });

  it.runIf(has)("lists the real workspace's samples", { timeout: 60000 }, () => {
    const samples = listFlowJoWorkspaceSamples(wsp());
    expect(samples.length).toBe(24);
    const lp4 = samples.find((s) => s.name === "LP4 rec.fcs")!;
    expect(lp4.eventCount).toBe(50000);
    expect(lp4.gateCount).toBe(12);
    expect(lp4.unsupportedCount).toBe(0);
  });

  it.runIf(has)("rebuilds the LP4 hierarchy end to end, through importGatingML", { timeout: 60000 }, () => {
    const out = flowJoWorkspaceToGatingML(wsp(), lp4Index());
    expect(out.warnings).toEqual([]);
    // FlowJo's own counts come across for a concordance readout.
    expect(out.flowJoCounts["Scatter"]).toBe(35712);
    expect(out.flowJoCounts["CD19+CD3−"]).toBe(16506);

    const chans = [...new Set([...out.gatingMl.matchAll(/data-type:name="([^"]+)"/g)].map((m) => m[1]))];
    const res = importGatingML(out.gatingMl, chans);
    expect(res.n_gates_imported).toBe(12);

    const byName: Record<string, any> = {};
    for (const p of Object.values(res.populations) as any[]) byName[p.name] = p;
    const parentOf = (n: string) => {
      const pid = byName[n].parent_id;
      return pid === res.root_population_id ? "ROOT" : (res.populations as any)[pid].name;
    };
    expect(parentOf("Scatter")).toBe("ROOT");
    expect(parentOf("SSC Singlets")).toBe("Scatter");
    expect(parentOf("FSC Singlets")).toBe("SSC Singlets");
    expect(parentOf("CD19+CD3−")).toBe("FSC Singlets");
    expect(parentOf("EarlyMem CD27+")).toBe("CD45RB+IgD+");
    expect(parentOf("Naive")).toBe("CD45RB−IgD+");
  });

  // The geometry is what makes the Gating-ML export redundant: the workspace already holds it.
  //
  // The vertices no longer pass through untouched. FlowJo stores them raw but evaluates the gate
  // as straight lines in the axis's DISPLAY space, so the converter moves them there and records
  // the transform on the gate. What must hold is that the move is exact and reversible: inverting
  // the transform the file declares recovers FlowJo's original raw coordinate.
  it.runIf(has)("moves the vertices into the declared space, reversibly", { timeout: 60000 }, () => {
    const out = flowJoWorkspaceToGatingML(wsp(), lp4Index());
    const doc = new DOMParser().parseFromString(out.gatingMl, "application/xml");

    const gate = Array.from(doc.getElementsByTagName("*"))
      .find((el) => el.localName === "PolygonGate");
    expect(gate, "the LP4 tree has a polygon gate").toBeTruthy();

    const marker = Array.from(gate!.getElementsByTagName("*"))
      .find((el) => el.localName === WSP_GATE_SPACE_TAG);
    expect(marker, "its space is recorded on the gate").toBeTruthy();
    const space = JSON.parse(marker!.textContent!) as {
      space: string; x: TransformSpec; y: TransformSpec;
    };
    // LP4 displays this pair on log axes, which is exactly where the coordinate space matters.
    expect(space.space).toBe("display");
    expect(space.x.kind).toBe("wsplog");

    const inv = { x: transformFromSpec(space.x).inverse, y: transformFromSpec(space.y).inverse };
    const written: number[][] = [];
    for (const v of Array.from(gate!.getElementsByTagName("*"))) {
      if (v.localName !== "vertex") continue;
      const cs = Array.from(v.getElementsByTagName("*")).filter((c) => c.localName === "coordinate");
      written.push(cs.map((c) => Number(c.getAttribute("data-type:value"))));
    }
    expect(written.length).toBeGreaterThan(2);

    // FlowJo's own raw coordinates, recovered from what the file now holds.
    const rawX = written.map((v) => inv.x(v[0]));
    const rawY = written.map((v) => inv.y(v[1]));
    expect(rawX.some((v) => Math.abs(v - 30887444.5705699) < 1e-3)).toBe(true);
    expect(rawY.some((v) => Math.abs(v - 759668.2975150499) < 1e-3)).toBe(true);
  });
});

// ── Transform carriage edge cases (synthetic, because no real workspace exhibits them) ──────────

const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";

/** A workspace in FlowJo's real shape: Transformations is a SIBLING of SampleNode. */
function syntheticWithTransforms(transforms: string, populations: string): string {
  return `<Workspace xmlns:transforms="${T}" xmlns:data-type="${D}">
    <SampleList><Sample>
      <Transformations>${transforms}</Transformations>
      <SampleNode name="s.fcs" count="100"><Subpopulations>${populations}</Subpopulations></SampleNode>
    </Sample></SampleList></Workspace>`;
}
const biexFor = (param: string, pos = 4.418539922): string =>
  `<transforms:biex transforms:maxRange="262144" transforms:pos="${pos}" transforms:neg="0"
     transforms:width="-10" transforms:length="256">
     <data-type:parameter data-type:name="${param}"/></transforms:biex>`;
const logicleFor = (param: string): string =>
  `<transforms:logicle transforms:T="262144" transforms:W="0.5" transforms:M="4.5" transforms:A="0">
     <data-type:parameter data-type:name="${param}"/></transforms:logicle>`;
const linearFor = (param: string): string =>
  `<transforms:linear transforms:minRange="0" transforms:maxRange="262144">
     <data-type:parameter data-type:name="${param}"/></transforms:linear>`;

describe("FlowJo transform carriage", () => {
  it("carries a biex pair and marks the gate's space", () => {
    const xml = syntheticWithTransforms(biexFor("X") + biexFor("Y"), polygonPop("A", "g1"));
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.gatingMl).toContain(WSP_GATE_SPACE_TAG);
    expect(out.gatingMl).toMatch(/"kind":"biex"/);
  });

  it("carries a logicle pair — FlowJo can display logicle, and GateLab holds that space", () => {
    const xml = syntheticWithTransforms(logicleFor("X") + logicleFor("Y"), polygonPop("A", "g1"));
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.gatingMl).toContain(WSP_GATE_SPACE_TAG);
    expect(out.gatingMl).toMatch(/"kind":"logicle"/);
    expect(out.warnings.join(" ")).not.toMatch(/RAW space/);
  });

  it("warns — not silently drops — a biex axis whose partner is undeclared", () => {
    // Only X is in the Transformations block. The pair cannot be carried without guessing what
    // FlowJo means by an undeclared axis, so the gate imports straight-in-raw; the previously
    // SILENT part was that X's biex bend vanished without a word.
    const xml = syntheticWithTransforms(biexFor("X"), polygonPop("A", "g1"));
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.gatingMl).not.toContain(WSP_GATE_SPACE_TAG);
    expect(out.warnings.join(" ")).toMatch(/biex/);
    expect(out.warnings.join(" ")).toMatch(/RAW space/);
    expect(out.warnings.join(" ")).toMatch(/"A"/);
  });

  it("stays silent when the pair is linear + undeclared, where nothing bends", () => {
    const xml = syntheticWithTransforms(linearFor("X"), polygonPop("A", "g1"));
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.gatingMl).not.toContain(WSP_GATE_SPACE_TAG);
    expect(out.warnings.join(" ")).not.toMatch(/RAW space/);
  });

  it("degrades a biex whose parameters cannot build a table to warned straight-in-raw", () => {
    // pos=400 sends exp() past overflow while the minimum underflows to zero: the calibration
    // table comes out NaN. Before the table guard this produced a silently all-false gate; now
    // the spec is rejected at parse time and the gate takes the named straight-in-raw path.
    const xml = syntheticWithTransforms(
      biexFor("X", 400) + biexFor("Y", 400), polygonPop("A", "g1"));
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.gatingMl).not.toContain(WSP_GATE_SPACE_TAG);
    expect(out.warnings.join(" ")).toMatch(/biex/);
    expect(out.warnings.join(" ")).toMatch(/RAW space/);
  });
});

// Three FlowJo conventions found on 2026-09-03 in a public workspace (Michaelis et al. 2025,
// Zenodo 16749334, LSRFortessa X-20, FlowJo 10.10.0), each of which made the import wrong
// without any error: a leaf name repeated under different parents, a Time gate stored in
// seconds, and (in sample.test.ts) a slashed parameter name rewritten with an underscore.
describe("FlowJo workspace import — names and units from a public ICS workspace", () => {
  function sampleWith(keywords: string, populations: string): string {
    return `<Workspace><SampleList><Sample><Keywords>${keywords}</Keywords>
      <SampleNode name="s.fcs" count="100"><Subpopulations>${populations}</Subpopulations></SampleNode>
    </Sample></SampleList></Workspace>`;
  }
  function rectPop(name: string, id: string, x: string, y: string,
                   xr: [number, number], yr: [number, number], inner = ""): string {
    return `<Population name="${name}" count="10"><Gate>
      <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="${id}">
        <gating:dimension gating:min="${xr[0]}" gating:max="${xr[1]}"><data-type:fcs-dimension data-type:name="${x}"/></gating:dimension>
        <gating:dimension gating:min="${yr[0]}" gating:max="${yr[1]}"><data-type:fcs-dimension data-type:name="${y}"/></gating:dimension>
      </gating:RectangleGate></Gate>
      ${inner ? `<Subpopulations>${inner}</Subpopulations>` : ""}
    </Population>`;
  }
  function rectangleRanges(gatingMl: string, gateId: string): [number, number][] {
    const doc = new DOMParser().parseFromString(gatingMl, "application/xml");
    const gate = Array.from(doc.getElementsByTagNameNS(G, "RectangleGate"))
      .find((g) => g.getAttributeNS(G, "id") === gateId)!;
    return Array.from(gate.getElementsByTagNameNS(G, "dimension")).map((d) => [
      Number(d.getAttributeNS(G, "min")), Number(d.getAttributeNS(G, "max")),
    ]);
  }

  it("qualifies a leaf name that recurs under different parents, and only that one", () => {
    const xml = synthetic(
      polygonPop("A", "g1", polygonPop("X", "g2")) + polygonPop("B", "g3", polygonPop("X", "g4")),
    );
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.gatingMl).toContain('gating:name="A/X"');
    expect(out.gatingMl).toContain('gating:name="B/X"');
    expect(out.gatingMl).toContain('gating:name="A"');
    expect(out.gatingMl).not.toContain('gating:name="X"');
    expect(Object.keys(out.flowJoCounts).sort()).toEqual(["A", "A/X", "B", "B/X"]);
    expect(out.warnings.some((w) => w.includes("qualified with their parent"))).toBe(true);
  });

  it("climbs as many parents as it takes, and no further", () => {
    // X under A/P and under B/P: "P/X" is still ambiguous, so both climb to "A/P/X" and "B/P/X".
    const xml = synthetic(
      polygonPop("A", "g1", polygonPop("P", "g2", polygonPop("X", "g3"))) +
      polygonPop("B", "g4", polygonPop("P", "g5", polygonPop("X", "g6"))),
    );
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(Object.keys(out.flowJoCounts).sort()).toEqual(["A", "A/P", "A/P/X", "B", "B/P", "B/P/X"]);
  });

  it("returns a Time gate from FlowJo's seconds to the file's ticks with the sample's $TIMESTEP", () => {
    const xml = sampleWith(
      `<Keyword name="$FIL" value="s.fcs"/><Keyword name="$TIMESTEP" value="0.01"/>`,
      rectPop("Time subset", "g1", "FSC-A", "Time", [6000, 160000], [0.5, 23]),
    );
    const out = flowJoWorkspaceToGatingML(xml, 0);
    const [fsc, time] = rectangleRanges(out.gatingMl, "g1");
    expect(fsc).toEqual([6000, 160000]);
    expect(time[0]).toBeCloseTo(50, 9);
    expect(time[1]).toBeCloseTo(2300, 9);
  });

  it("leaves Time alone when the workspace records no $TIMESTEP, and never touches another axis", () => {
    const xml = sampleWith(
      `<Keyword name="$FIL" value="s.fcs"/>`,
      rectPop("Time subset", "g1", "Time", "SSC-A", [0.5, 23], [100, 900]),
    );
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(rectangleRanges(out.gatingMl, "g1")).toEqual([[0.5, 23], [100, 900]]);
  });
});

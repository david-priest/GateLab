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
    const child = polygonPop("UnderQuadrant", "g2");
    const xml = synthetic(
      `<Population name="Quadrant" count="9"><Gate>
         <gating:QuadrantGate xmlns:gating="${G}" gating:id="g1"/></Gate>
         <Subpopulations>${child}</Subpopulations></Population>` + polygonPop("Fine", "g3"),
    );
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.gatingMl).toContain('gating:name="Fine"');
    expect(out.gatingMl).not.toContain("UnderQuadrant");
    expect(out.warnings.join(" ")).toMatch(/QuadrantGate/);
    expect(out.warnings.join(" ")).toMatch(/skipped/);
  });

  it("skips an ellipsoid whose axes the workspace declares no display for", () => {
    const xml = synthetic(
      `<Population name="Blob" count="9"><Gate>
         <gating:EllipsoidGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="e1"
                               gating:distance="52">
           <gating:dimension><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
           <gating:dimension><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
         </gating:EllipsoidGate></Gate>
         <Subpopulations>${polygonPop("UnderBlob", "g2")}</Subpopulations></Population>`
      + polygonPop("Fine", "g3"),
    );
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.gatingMl).toContain('gating:name="Fine"');
    expect(out.gatingMl).not.toContain("UnderBlob");
    expect(out.warnings.join(" ")).toMatch(/ellipse/);
    expect(out.warnings.join(" ")).toMatch(/skipped/);
  });

  // A CurlyQuad is one quadrant of a crosshair FlowJo bends beyond it (see QuadrantCurl). Here
  // the axes declare no display, so the bend cannot be placed and the crosshair imports straight,
  // as a quadrant gate whose one population names its quadrant -- and says why.
  it("reads a CurlyQuad as a quadrant gate, straight when its axes' display is unknown", () => {
    const xml = synthetic(
      `<Population name="DoublePositive" count="9"><Gate>
         <gating:CurlyQuad xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="q1"
                           percentX="0" percentY="0">
           <gating:dimension gating:min="500"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
           <gating:dimension gating:min="700"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
         </gating:CurlyQuad></Gate>
         <Subpopulations>${polygonPop("UnderQuad", "g2")}</Subpopulations></Population>`,
    );
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.gatingMl).toContain("RectangleGate");
    expect(out.gatingMl).not.toContain("CurlyQuad");
    expect(out.warnings.some((w) => /"DoublePositive".*straight/.test(w))).toBe(true);
    const res = importGatingML(out.gatingMl, ["X", "Y"], {}, "flow");
    const quad = Object.values(res.gates).find((g) => g.gate_type === "quadrant") as unknown as
      { center: [number, number]; curl?: unknown } | undefined;
    expect(quad).toBeDefined();
    expect(quad!.center).toEqual([500, 700]);
    expect(quad!.curl).toBeUndefined();
    const pops = Object.values(res.populations) as unknown as Array<{
      population_id: string; name: string; parent_id: string | null;
      gate_refs: Array<{ gate_id: string; include: boolean; quadrant?: number }>;
    }>;
    const dp = pops.find((p) => p.name === "DoublePositive")!;
    expect(dp.gate_refs).toHaveLength(1);
    expect(dp.gate_refs[0].quadrant).toBe(2);
    // The point of reading it at all: the subtree below survives, beneath the quadrant.
    expect(pops.find((p) => p.name === "UnderQuad")!.parent_id).toBe(dp.population_id);
  });

  // <AndNode> carries no gate: it names the populations it intersects, by full path. GateLab's
  // Population is already an intersection of gate refs, so the two line up -- but a gate-less
  // population has to reach the importer somehow, and emitting BooleanGates instead flips the
  // document onto the Cytobank flat-Boolean reading, which discards every ordinary population.
  it("imports an AndNode as the intersection of the populations it names", () => {
    const xml = synthetic(
      `<Population name="Parent" count="100"><Gate>
         <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="p1">
           <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
           <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
         </gating:RectangleGate></Gate>
         <Subpopulations>
           ${polygonPop("A", "a1")}
           ${polygonPop("B", "b1")}
           <NotNode name="B-" count="7"><Gate>
             <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="b1copy">
               <gating:dimension gating:min="1"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
               <gating:dimension gating:min="1"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
             </gating:RectangleGate></Gate>
             <Dependents><Dependent name="Parent/B"/></Dependents></NotNode>
           <AndNode name="A+B-" count="3">
             <Dependents>
               <Dependent name="Parent/A"/>
               <Dependent name="Parent/B-"/>
             </Dependents></AndNode>
         </Subpopulations></Population>`,
    );
    const out = flowJoWorkspaceToGatingML(xml, 0);
    const res = importGatingML(out.gatingMl, ["X", "Y"], {}, "flow");
    const pops = Object.values(res.populations) as unknown as Array<{
      name: string; gate_refs: Array<{ gate_id: string; include: boolean }>; parent_id: string | null;
    }>;
    const gateNamed = (name: string) =>
      (Object.entries(res.gates).find(([, g]) => (g as unknown as { name: string }).name === name) ?? [])[0];
    const and = pops.find((p) => p.name.endsWith("A+B-"));
    expect(and).toBeDefined();
    // Two operands, and the NotNode one is EXCLUDED: its population is the complement of the
    // population it names, so depending on it means excluding THAT population's gate.
    expect(and!.gate_refs).toHaveLength(2);
    expect(and!.gate_refs.filter((r) => r.include).map((r) => r.gate_id)).toEqual([gateNamed("A")]);
    expect(and!.gate_refs.filter((r) => !r.include).map((r) => r.gate_id)).toEqual([gateNamed("B")]);
    // It sits under the node it was written in, so it is measured inside that parent.
    const parent = pops.find((p) => p.name === "Parent");
    expect(and!.parent_id).toBe((parent as unknown as { population_id: string }).population_id);
    // and the ordinary populations are all still there -- the failure mode this guards.
    expect(pops.map((p) => p.name)).toEqual(expect.arrayContaining(["Parent", "A", "B", "B-"]));
  });

  // FlowJo stores a COPY of the negated gate inside a NotNode, and when the workspace tailors
  // gates per sample the copy goes stale. FlowJo's own count for the NOT population is the
  // complement of the population it names, with that population's CURRENT gate; on FR-FCM-Z2V4
  // reading the copy instead put the root NOT population 6% of the file out, and every
  // population beneath it with it.
  it("reads a NOT population as the complement of the population it names, not of the copy it carries", () => {
    const xml = synthetic(
      `<Population name="Parent" count="100"><Gate>
         <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="p1">
           <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
           <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
         </gating:RectangleGate></Gate>
         <Subpopulations>
           ${polygonPop("A", "a1")}
           <NotNode name="A-" count="90"><Gate>
             <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="stale">
               <gating:dimension gating:min="50"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
               <gating:dimension gating:min="50"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
             </gating:RectangleGate></Gate>
             <Dependents><Dependent name="Parent/A"/></Dependents>
             <Subpopulations>${polygonPop("UnderNot", "u1")}</Subpopulations></NotNode>
         </Subpopulations></Population>`,
    );
    const out = flowJoWorkspaceToGatingML(xml, 0);
    // The stale copy is not emitted at all.
    expect(out.gatingMl).not.toContain('gating:id="stale"');
    expect(out.warnings.filter((w) => /A-/.test(w))).toEqual([]);
    const res = importGatingML(out.gatingMl, ["X", "Y"], {}, "flow");
    const pops = Object.values(res.populations) as unknown as Array<{
      population_id: string; name: string; parent_id: string | null;
      gate_refs: Array<{ gate_id: string; include: boolean }>;
    }>;
    const a = Object.entries(res.gates).find(([, g]) => (g as unknown as { name: string }).name === "A")![0];
    const notPop = pops.find((p) => p.name === "A-")!;
    expect(notPop.gate_refs).toEqual([{ gate_id: a, include: false }]);
    expect(notPop.parent_id).toBe(pops.find((p) => p.name === "Parent")!.population_id);
    // What FlowJo gated beneath the NOT population is measured inside it.
    expect(pops.find((p) => p.name === "UnderNot")!.parent_id).toBe(notPop.population_id);
    expect(out.flowJoCounts["A-"]).toBe(90);
  });

  it("falls back to the copy a NOT population carries when the population it names is absent, and says so", () => {
    const xml = synthetic(
      `<Population name="Parent" count="100"><Gate>
         <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="p1">
           <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
           <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
         </gating:RectangleGate></Gate>
         <Subpopulations>
           <NotNode name="Gone-" count="90"><Gate>
             <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="copy">
               <gating:dimension gating:min="5"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
               <gating:dimension gating:min="5"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
             </gating:RectangleGate></Gate>
             <Dependents><Dependent name="Parent/Gone"/></Dependents>
             <Subpopulations>${polygonPop("UnderNot", "u1")}</Subpopulations></NotNode>
         </Subpopulations></Population>`,
    );
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.warnings.some((w) => /"Gone-".*copy.*stale/.test(w))).toBe(true);
    const res = importGatingML(out.gatingMl, ["X", "Y"], {}, "flow");
    const pops = Object.values(res.populations) as unknown as Array<{
      population_id: string; name: string; parent_id: string | null;
      gate_refs: Array<{ gate_id: string; include: boolean }>;
    }>;
    const notPop = pops.find((p) => p.name === "Gone-")!;
    // The copy, as the complement it is, with the subtree still beneath it.
    expect(notPop.gate_refs).toHaveLength(1);
    expect(notPop.gate_refs[0].include).toBe(false);
    expect((res.gates[notPop.gate_refs[0].gate_id] as unknown as { name: string }).name).toBe("Gone-");
    expect(pops.find((p) => p.name === "UnderNot")!.parent_id).toBe(notPop.population_id);
  });

  it("refuses the complement of an intersection, which is a union, together with what lies beneath it", () => {
    const xml = synthetic(
      `<Population name="Parent" count="100"><Gate>
         <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="p1">
           <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
           <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
         </gating:RectangleGate></Gate>
         <Subpopulations>
           ${polygonPop("A", "a1")}
           ${polygonPop("B", "b1")}
           <AndNode name="A+B" count="3"><Dependents>
             <Dependent name="Parent/A"/><Dependent name="Parent/B"/></Dependents></AndNode>
           <NotNode name="not A+B" count="97">
             <Dependents><Dependent name="Parent/A+B"/></Dependents>
             <Subpopulations>${polygonPop("UnderNot", "u1")}</Subpopulations></NotNode>
         </Subpopulations></Population>`,
    );
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.warnings.some((w) => /"not A\+B".*union/.test(w) && /1 population\(s\) beneath/.test(w))).toBe(true);
    const res = importGatingML(out.gatingMl, ["X", "Y"], {}, "flow");
    const names = Object.values(res.populations).map((p) => (p as unknown as { name: string }).name);
    expect(names).toEqual(expect.arrayContaining(["Parent", "A", "B", "A+B"]));
    expect(names).not.toContain("not A+B");
    expect(names).not.toContain("UnderNot");
  });

  it("skips an intersection whose operands it could not read, rather than widening it", () => {
    const xml = synthetic(
      `<Population name="Parent" count="100"><Gate>
         <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="p1">
           <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
           <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
         </gating:RectangleGate></Gate>
         <Subpopulations>
           ${polygonPop("A", "a1")}
           <AndNode name="A+Missing" count="3">
             <Dependents>
               <Dependent name="Parent/A"/>
               <Dependent name="Parent/NoSuchPopulation"/>
             </Dependents></AndNode>
         </Subpopulations></Population>`,
    );
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.warnings.join(" ")).toMatch(/NoSuchPopulation/);
    const res = importGatingML(out.gatingMl, ["X", "Y"], {}, "flow");
    const names = Object.values(res.populations).map((p) => (p as unknown as { name: string }).name);
    expect(names).not.toContain("A+Missing");
    expect(names).toEqual(expect.arrayContaining(["Parent", "A"]));
  });

  // A conjunction of conjunctions is one conjunction: an AndNode whose operand is another
  // AndNode flattens into that node's operands. 23,864 operands in the survey corpus are AndNodes.
  it("flattens an AndNode whose operand is another AndNode", () => {
    const rect = (id: string, name: string, lo: number) => `<Population name="${name}" count="5"><Gate>
         <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="${id}">
           <gating:dimension gating:min="${lo}"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
           <gating:dimension gating:min="${lo}"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
         </gating:RectangleGate></Gate></Population>`;
    const xml = synthetic(
      `<Population name="Parent" count="100"><Gate>
         <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="p1">
           <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
           <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
         </gating:RectangleGate></Gate>
         <Subpopulations>
           ${rect("a1", "A", 1)}${rect("b1", "B", 2)}${rect("c1", "C", 3)}
           <AndNode name="A+B" count="3"><Dependents>
             <Dependent name="Parent/A"/><Dependent name="Parent/B"/></Dependents></AndNode>
           <AndNode name="A+B+C" count="2"><Dependents>
             <Dependent name="Parent/A+B"/><Dependent name="Parent/C"/></Dependents></AndNode>
         </Subpopulations></Population>`,
    );
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.warnings.join(" ")).not.toMatch(/skipped/);
    const res = importGatingML(out.gatingMl, ["X", "Y"], {}, "flow");
    const gates = res.gates as unknown as Record<string, { name: string }>;
    const pops = Object.values(res.populations) as unknown as Array<{
      name: string; gate_refs: Array<{ gate_id: string; include: boolean }>;
    }>;
    const abc = pops.find((p) => p.name.endsWith("A+B+C"))!;
    expect(abc.gate_refs.map((r) => gates[r.gate_id].name).sort()).toEqual(["A", "B", "C"]);
    expect(abc.gate_refs.every((r) => r.include)).toBe(true);
  });

  // An operand from another branch carries its own ancestors' gates; a reference to its gate
  // alone would silently widen the intersection, so the node is refused and named instead.
  it("refuses an AndNode operand from another branch rather than dropping its ancestry", () => {
    const box = (id: string, bound: "min" | "max") => `<Gate>
         <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="${id}">
           <gating:dimension gating:${bound}="0"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
           <gating:dimension gating:${bound}="0"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
         </gating:RectangleGate></Gate>`;
    const xml = synthetic(
      `<Population name="Left" count="100">${box("l1", "min")}
         <Subpopulations>${polygonPop("Deep", "d1")}</Subpopulations></Population>
       <Population name="Right" count="100">${box("r1", "max")}
         <Subpopulations>
           ${polygonPop("Near", "n1")}
           <AndNode name="Near+Deep" count="1"><Dependents>
             <Dependent name="Right/Near"/><Dependent name="Left/Deep"/></Dependents></AndNode>
         </Subpopulations></Population>`,
    );
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.warnings.join(" ")).toMatch(/Near\+Deep/);
    expect(out.warnings.join(" ")).toMatch(/ancestry/);
    const names = Object.values(importGatingML(out.gatingMl, ["X", "Y"], {}, "flow").populations)
      .map((p) => (p as unknown as { name: string }).name);
    expect(names.some((n) => n.endsWith("Near+Deep"))).toBe(false);
    expect(names).toEqual(expect.arrayContaining(["Left", "Right"]));
  });

  // FlowJo gates freely beneath an intersection: 17,197 populations in the survey corpus sit
  // under an AndNode. Each is measured inside it, so each is parented under it -- a gate through
  // its parent_id, a nested intersection through the id the outer one carries.
  it("nests what is gated beneath an intersection under it", () => {
    const xml = synthetic(
      `<Population name="Parent" count="100"><Gate>
         <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="p1">
           <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
           <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
         </gating:RectangleGate></Gate>
         <Subpopulations>
           ${polygonPop("A", "a1")}${polygonPop("B", "b1")}
           <AndNode name="A+B" count="5"><Dependents>
             <Dependent name="Parent/A"/><Dependent name="Parent/B"/></Dependents>
             <Subpopulations>
               ${polygonPop("C", "c1")}${polygonPop("D", "d1")}
               <AndNode name="C+D" count="2"><Dependents>
                 <Dependent name="Parent/A+B/C"/><Dependent name="Parent/A+B/D"/></Dependents>
                 <Subpopulations>${polygonPop("E", "e1")}</Subpopulations></AndNode>
             </Subpopulations></AndNode>
         </Subpopulations></Population>`,
    );
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.warnings.join(" ")).not.toMatch(/skipped/);
    const res = importGatingML(out.gatingMl, ["X", "Y"], {}, "flow");
    const gates = res.gates as unknown as Record<string, { name: string }>;
    const pops = Object.values(res.populations) as unknown as Array<{
      population_id: string; name: string; parent_id: string | null;
      gate_refs: Array<{ gate_id: string; include: boolean }>;
    }>;
    const find = (n: string) => pops.find((p) => p.name === n || p.name.endsWith(`/${n}`))!;
    const ab = find("A+B"), c = find("C"), cd = find("C+D"), e = find("E");
    expect(c.parent_id).toBe(ab.population_id);
    expect(c.gate_refs.map((r) => gates[r.gate_id].name)).toEqual(["C"]);
    expect(cd.parent_id).toBe(ab.population_id);
    expect(cd.gate_refs.map((r) => gates[r.gate_id].name).sort()).toEqual(["C", "D"]);
    expect(e.parent_id).toBe(cd.population_id);
  });

  it("drops what is gated beneath an intersection it could not resolve", () => {
    // It was measured inside that intersection, and there is no population left to measure it in.
    const xml = synthetic(
      `<Population name="Parent" count="100"><Gate>
         <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="p1">
           <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
           <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
         </gating:RectangleGate></Gate>
         <Subpopulations>
           ${polygonPop("A", "a1")}
           <AndNode name="A+Missing" count="3"><Dependents>
             <Dependent name="Parent/A"/><Dependent name="Parent/NoSuchPopulation"/></Dependents>
             <Subpopulations>${polygonPop("Under", "u1", polygonPop("Deeper", "u2"))}</Subpopulations></AndNode>
         </Subpopulations></Population>`,
    );
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.warnings.join(" ")).toMatch(/A\+Missing.*2 population\(s\) beneath it/);
    expect(out.gatingMl).not.toContain('gating:name="Under"');
    expect(out.gatingMl).not.toContain('gating:name="Deeper"');
    const names = Object.values(importGatingML(out.gatingMl, ["X", "Y"], {}, "flow").populations)
      .map((p) => (p as unknown as { name: string }).name);
    expect(names).toEqual(expect.arrayContaining(["Parent", "A"]));
    expect(names.some((n) => n.endsWith("Under") || n.endsWith("Deeper"))).toBe(false);
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

  // Each tree can also be converted on its own, which is what importing them into separate
  // hierarchies needs: one document per strategy, none of them carrying another's gates.
  it("converts one parallel tree at a time, without the others' gates", () => {
    const xml = synthetic(polygonPop("TreeA", "g1", polygonPop("Leaf", "g3")) + polygonPop("TreeB", "g2"));
    const first = flowJoWorkspaceToGatingML(xml, 0, 0);
    const second = flowJoWorkspaceToGatingML(xml, 0, 1);
    expect(first.gatingMl).toContain('gating:name="TreeA"');
    expect(first.gatingMl).toContain('gating:name="Leaf"');
    expect(first.gatingMl).not.toContain('gating:name="TreeB"');
    expect(second.gatingMl).toContain('gating:name="TreeB"');
    expect(second.gatingMl).not.toContain('gating:name="TreeA"');
    // Converted one at a time, neither run reports the merge that importing them together is.
    expect(first.warnings.join(" ")).not.toMatch(/independent gating trees/);
    expect(listFlowJoWorkspaceSamples(xml)[0].trees.map((t) => t.name)).toEqual(["TreeA", "TreeB"]);
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
  // FlowJo writes an ellipsoid's foci in DISPLAY CHANNELS while the polygons beside it are raw,
  // so the conversion is what decides whether the gate lands on the data or a few hundred units
  // from the origin. Foci 20 channels apart with a 52-channel major axis give semi-axes 26 and
  // 24; on a 0..262144 linear axis one channel is 1024 raw units.
  it("converts a FlowJo ellipsoid out of display channels into raw", () => {
    const xml = syntheticWithTransforms(
      linearFor("X") + linearFor("Y"),
      `<Population name="Blob" count="9"><Gate>
         <gating:EllipsoidGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="e1"
                               gating:distance="52">
           <gating:dimension><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
           <gating:dimension><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
           <gating:foci>
             <gating:vertex><gating:coordinate data-type:value="100"/><gating:coordinate data-type:value="128"/></gating:vertex>
             <gating:vertex><gating:coordinate data-type:value="120"/><gating:coordinate data-type:value="128"/></gating:vertex>
           </gating:foci>
         </gating:EllipsoidGate></Gate></Population>`,
    );
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.warnings.join(" ")).not.toMatch(/skipped/);
    const gates = Object.values(importGatingML(out.gatingMl, ["X", "Y"], {}, "flow").gates);
    expect(gates).toHaveLength(1);
    const g = gates[0] as unknown as {
      gate_type: string; mean: [number, number]; covariance: number[][]; distance_square: number;
    };
    expect(g.gate_type).toBe("ellipse");
    expect(g.mean).toEqual([110 * 1024, 128 * 1024]);
    // Axis-aligned here, so the covariance is diag(a^2, b^2) scaled by the channel width squared.
    expect(g.covariance[0][0]).toBeCloseTo(676 * 1024 * 1024, 0);
    expect(g.covariance[1][1]).toBeCloseTo(576 * 1024 * 1024, 0);
    expect(g.covariance[0][1]).toBeCloseTo(0, 6);
    expect(g.distance_square).toBe(1);
  });

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

// Four CurlyQuads sharing one crosshair under biex-displayed axes: ONE quadrant gate carrying
// FlowJo's bend in that display space, four populations naming its quadrants, and the subtree
// beneath a quadrant kept beneath it.
describe("FlowJo curly quadrants", () => {
  const curlyPop = (name: string, id: string, xBound: "min" | "max", yBound: "min" | "max", inner = "") =>
    `<Population name="${name}" count="10"><Gate>
       <gating:CurlyQuad xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="${id}" percentX="0" percentY="0">
         <gating:dimension gating:${xBound}="1000"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
         <gating:dimension gating:${yBound}="2000"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
       </gating:CurlyQuad></Gate>
       ${inner ? `<Subpopulations>${inner}</Subpopulations>` : ""}</Population>`;

  it("becomes one quadrant gate with FlowJo's bend and four quadrant populations", () => {
    const xml = syntheticWithTransforms(
      biexFor("X") + biexFor("Y"),
      polygonPop("Parent", "p1",
        curlyPop("Q1", "q1", "max", "min") +
        curlyPop("Q2", "q2", "min", "min", polygonPop("UnderQ2", "u1")) +
        curlyPop("Q3", "q3", "min", "max") +
        curlyPop("Q4", "q4", "max", "max")),
    );
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.warnings.filter((w) => /straight|skipped/.test(w))).toEqual([]);
    expect(out.gatingMl).toContain("gatelab_curly_quadrant");
    const res = importGatingML(out.gatingMl, ["X", "Y"], {}, "flow");
    const quads = Object.values(res.gates).filter((g) => g.gate_type === "quadrant") as unknown as
      Array<{ gate_id: string; center: [number, number]; curl?: { power: number; kx: number; ky: number }; space?: string }>;
    expect(quads).toHaveLength(1);
    const [quad] = quads;
    expect(quad.space).toBe("display");
    expect(quad.curl).toEqual({ power: 1.5, kx: 0.012, ky: 0.012 });
    // The crosshair was carried into FlowJo's display space along with the vertices.
    expect(quad.center[0]).toBeGreaterThan(0);
    expect(quad.center[0]).toBeLessThan(256);
    const pops = Object.values(res.populations) as unknown as Array<{
      population_id: string; name: string; parent_id: string | null;
      gate_refs: Array<{ gate_id: string; include: boolean; quadrant?: number }>;
    }>;
    const parent = pops.find((p) => p.name === "Parent")!;
    for (const [name, q] of [["Q1", 1], ["Q2", 2], ["Q3", 3], ["Q4", 4]] as const) {
      const pop = pops.find((p) => p.name === name)!;
      expect(pop.gate_refs).toEqual([{ gate_id: quad.gate_id, include: true, quadrant: q }]);
      expect(pop.parent_id).toBe(parent.population_id);
    }
    expect(pops.find((p) => p.name === "UnderQ2")!.parent_id).toBe(pops.find((p) => p.name === "Q2")!.population_id);
    // The shared gate has no population of its own.
    expect(pops.filter((p) => p.gate_refs.some((r) => r.gate_id === quad.gate_id))).toHaveLength(4);
    expect(out.flowJoCounts["Q1"]).toBe(10);
  });
});

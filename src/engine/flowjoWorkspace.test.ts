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
import { applyGatingStrategy } from "./populations";
import { describeDiffering, planOneTreeImport } from "./oneTreeImport";
import { translateUi } from "../ui/i18n";

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

  // A NotNode naming two populations cannot be represented, and was read from the copy FlowJo
  // stores inside it -- the stale gate -- although both populations were in the sample. The copy
  // is for a population nowhere in the sample; here the NOT is refused, by name.
  it("refuses a NOT naming two populations of the sample, rather than reading the copy it carries", () => {
    const xml = synthetic(
      `<Population name="Parent" count="100"><Gate>
         <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="p1">
           <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
           <gating:dimension gating:min="0"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
         </gating:RectangleGate></Gate>
         <Subpopulations>
           ${polygonPop("A", "a1")}
           ${polygonPop("B", "b1")}
           <NotNode name="AB-" count="90"><Gate>
             <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="stale">
               <gating:dimension gating:min="50"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
               <gating:dimension gating:min="50"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
             </gating:RectangleGate></Gate>
             <Dependents><Dependent name="Parent/A"/><Dependent name="Parent/B"/></Dependents></NotNode>
         </Subpopulations></Population>`,
    );
    const out = flowJoWorkspaceToGatingML(xml, 0);
    expect(out.gatingMl).not.toContain('gating:id="stale"');
    expect(out.warnings.some((w) => /AB-/.test(w) && /names 2 populations/.test(w))).toBe(true);
    expect(out.warnings.some((w) => /AB-.*copy.*stale/.test(w))).toBe(false);
    const res = importGatingML(out.gatingMl, ["X", "Y"], {}, "flow");
    const names = Object.values(res.populations).map((p) => (p as unknown as { name: string }).name);
    expect(names).not.toContain("AB-");
    expect(names).toEqual(expect.arrayContaining(["Parent", "A", "B"]));
  });

  // A NotNode at the TOP level can name a population in another of the sample's trees. Imported
  // one tree at a time, as the app imports a picked tree, that population is not in the tree being
  // converted, and the NotNode used to fall back on the copy of the gate stored inside it -- stale
  // wherever the workspace tailors gates per sample, which moved counts away from FlowJo's without
  // a word about why.
  describe("a top-level NOT naming a population in another tree", () => {
    const rectPop = (name: string, id: string, max: number, inner = "") => `<Population name="${name}" count="10"><Gate>
      <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="${id}">
        <gating:dimension gating:min="0" gating:max="${max}"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
        <gating:dimension gating:min="0.0" gating:max="${max}"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
      </gating:RectangleGate></Gate>
      ${inner ? `<Subpopulations>${inner}</Subpopulations>` : ""}</Population>`;
    const notNode = (name: string, dependent: string, storedMax: number | null) => `<NotNode name="${name}" count="90">
      ${storedMax === null ? "" : `<Gate>
      <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="stored">
        <gating:dimension gating:min="0.0" gating:max="${storedMax}"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
        <gating:dimension gating:min="0" gating:max="${storedMax}"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
      </gating:RectangleGate></Gate>`}
      <Subpopulations>${polygonPop("UnderNot", "u1")}</Subpopulations>
      <Dependents><Dependent name="${dependent}"/></Dependents></NotNode>`;
    type Pop = { population_id: string; name: string; parent_id: string | null; gate_refs: Array<{ gate_id: string; include: boolean }> };
    const read = (gatingMl: string) => {
      const res = importGatingML(gatingMl, ["X", "Y"], {}, "flow");
      const pops = Object.values(res.populations) as unknown as Pop[];
      const gate = (id: string) => res.gates[id] as unknown as { name: string; vertices: Array<[number, number]> };
      return { pops, gate };
    };

    it("imports the complement of the other tree's CURRENT gate, and says the stored copy differs", () => {
      const xml = synthetic(rectPop("A", "a1", 10) + notNode("A-", "A", 5));
      const out = flowJoWorkspaceToGatingML(xml, 0, 1);
      expect(out.gatingMl).not.toContain('gating:id="stored"');
      expect(out.gatingMl).not.toContain('gating:name="A"');
      const { pops, gate } = read(out.gatingMl);
      const notPop = pops.find((p) => p.name === "A-")!;
      expect(notPop.gate_refs).toHaveLength(1);
      expect(notPop.gate_refs[0].include).toBe(false);
      // The live gate's extent, 0 to 10, not the stored copy's 0 to 5.
      expect(Math.max(...gate(notPop.gate_refs[0].gate_id).vertices.map((v) => v[0]))).toBe(10);
      expect(pops.find((p) => p.name === "UnderNot")!.parent_id).toBe(notPop.population_id);
      const said = out.warnings.join("\n");
      expect(said).toMatch(/"A-" is the complement of "A", a gate in another of this sample's trees.*differs from the current one/);
      expect(said).not.toMatch(/sits under a skipped gate/);
      expect(said).not.toMatch(/could not be read/);
    });

    it("says nothing when the stored copy is the current gate", () => {
      const xml = synthetic(rectPop("A", "a1", 10) + notNode("A-", "A", 10));
      const out = flowJoWorkspaceToGatingML(xml, 0, 1);
      expect(out.warnings).toEqual([]);
      const { pops } = read(out.gatingMl);
      expect(pops.map((p) => p.name)).toEqual(expect.arrayContaining(["A-", "UnderNot"]));
    });

    it("gives the same membership as the merged import, where the complement is derived", () => {
      const xml = synthetic(rectPop("A", "a1", 10) + notNode("A-", "A", 5));
      const merged = read(flowJoWorkspaceToGatingML(xml, 0, null).gatingMl);
      const mergedNot = merged.pops.find((p) => p.name === "A-")!;
      expect(mergedNot.gate_refs).toEqual([{ gate_id: merged.pops.find((p) => p.name === "A")!.gate_refs[0].gate_id, include: false }]);
      const alone = read(flowJoWorkspaceToGatingML(xml, 0, 1).gatingMl);
      const aloneNot = alone.pops.find((p) => p.name === "A-")!;
      expect(alone.gate(aloneNot.gate_refs[0].gate_id).vertices)
        .toEqual(merged.gate(mergedNot.gate_refs[0].gate_id).vertices);
    });

    // FlowJo's NOT excludes the named population's gate alone, whatever its ancestry, so a
    // population with ancestors in another tree is excluded by its current gate like any other.
    // It used to be refused as "an OR of complements", which it is not.
    it("excludes the current gate of a population with ancestors in another tree", () => {
      // B's gate reaches beyond P: an event there is in B's gate but not in the population P/B.
      const wide = `<Population name="P" count="10"><Gate>
        <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="p1">
          <gating:dimension gating:min="0" gating:max="20"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
          <gating:dimension gating:min="0" gating:max="20"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
        </gating:RectangleGate></Gate><Subpopulations><Population name="B" count="2"><Gate>
        <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="b1">
          <gating:dimension gating:min="0" gating:max="30"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
          <gating:dimension gating:min="0" gating:max="10"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
        </gating:RectangleGate></Gate></Population></Subpopulations></Population>`;
      const xml = synthetic(wide + notNode("B-", "P/B", 5) + rectPop("C", "c1", 10));
      const out = flowJoWorkspaceToGatingML(xml, 0, 1);
      expect(out.gatingMl).not.toContain('gating:id="stored"');
      const { pops, gate } = read(out.gatingMl);
      const notPop = pops.find((p) => p.name === "B-")!;
      expect(notPop.gate_refs).toHaveLength(1);
      expect(notPop.gate_refs[0].include).toBe(false);
      // B's own gate, 0 to 30 on X: not the stored copy (0 to 5), and not P's gate intersected.
      expect(Math.max(...gate(notPop.gate_refs[0].gate_id).vertices.map((v) => v[0]))).toBe(30);
      expect(pops.find((p) => p.name === "UnderNot")!.parent_id).toBe(notPop.population_id);
      const said = out.warnings.join("\n");
      expect(said).toMatch(/"B-" is the complement of "B", a gate in another of this sample's trees.*differs from the current one/);
      expect(said).not.toMatch(/OR of complements/);
      // Merged, the NOT is derived from B's gate, the same exclusion.
      const merged = read(flowJoWorkspaceToGatingML(xml, 0, null).gatingMl);
      const mergedNot = merged.pops.find((p) => p.name === "B-")!;
      expect(mergedNot.gate_refs).toEqual([{ gate_id: merged.pops.find((p) => p.name === "B")!.gate_refs[0].gate_id, include: false }]);
    });

    it("refuses a top-level NOT naming an intersection in another tree, with its subtree", () => {
      const xml = synthetic(
        rectPop("A", "a1", 10) + rectPop("B", "b1", 10) +
        `<AndNode name="AB" count="5"><Dependents><Dependent name="A"/><Dependent name="B"/></Dependents></AndNode>` +
        notNode("AB-", "AB", 10),
      );
      // The tree is the NotNode and what lies beneath it, so refusing it leaves nothing to import,
      // and the error the user sees names the population and the reason.
      expect(() => flowJoWorkspaceToGatingML(xml, 0, 3)).toThrow(
        /"AB-" is a complement that was skipped: "AB" is an intersection in another of this sample's trees.*the 1 population\(s\) beneath it went with it/,
      );
    });

    it("tells an intersection whose operands are in other trees from one naming nothing", () => {
      const xml = synthetic(
        rectPop("A", "a1", 10) + rectPop("B", "b1", 10) +
        `<AndNode name="AB" count="5"><Dependents><Dependent name="A"/><Dependent name="B"/></Dependents></AndNode>`,
      );
      expect(() => flowJoWorkspaceToGatingML(xml, 0, 2)).toThrow(/"A" is in another of this sample's trees/);
    });

    it("still reads the stored copy when the population named is nowhere in the sample, and does not call it re-attached", () => {
      const xml = synthetic(rectPop("A", "a1", 10) + notNode("Gone-", "Gone", 5));
      const out = flowJoWorkspaceToGatingML(xml, 0, 1);
      const said = out.warnings.join("\n");
      expect(said).toMatch(/"Gone-" is the complement of a population that could not be read.*stale/);
      expect(said).not.toMatch(/sits under a skipped gate/);
    });
  });

  // FlowJo's NOT excludes the GATE of the population it names, alone, whatever that population's
  // ancestry: inside the NOT's container C it is C minus T's own gate. FlowJo's counts on
  // FR-FCM-Z73A and FR-FCM-Z2JV fit that reading and not the one that excludes T with its
  // ancestors. The copy of the gate FlowJo stores inside the node is not used: it goes stale on a
  // tailored workspace, and the complement used to fall back on it whenever T was not beside it.
  describe("a NOT naming a population in another branch of its own tree", () => {
    const box = (name: string, id: string, xMax: number, yMax: number, inner = "") => `<Population name="${name}" count="1"><Gate>
      <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="${id}">
        <gating:dimension gating:min="0" gating:max="${xMax}"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
        <gating:dimension gating:min="0" gating:max="${yMax}"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
      </gating:RectangleGate></Gate>
      ${inner ? `<Subpopulations>${inner}</Subpopulations>` : ""}</Population>`;
    // The stored copy is a smaller box than any live gate, so reading it is visible in the counts.
    const not = (name: string, dependent: string, inner = "") => `<NotNode name="${name}" count="1"><Gate>
      <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="stale">
        <gating:dimension gating:min="0" gating:max="3"><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
        <gating:dimension gating:min="0" gating:max="3"><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
      </gating:RectangleGate></Gate>
      ${inner ? `<Subpopulations>${inner}</Subpopulations>` : ""}
      <Dependents><Dependent name="${dependent}"/></Dependents></NotNode>`;
    // (x, y) events: inside B; inside Q but not B; inside P but not Q; outside P; inside the copy.
    const events: Array<[number, number]> = [[5, 5], [12, 5], [18, 5], [25, 25], [2, 2]];
    const counts = (gatingMl: string): Record<string, number> => {
      const res = importGatingML(gatingMl, ["X", "Y"], {}, "flow");
      const cols: Record<string, Float64Array> = {
        X: Float64Array.from(events.map((e) => e[0])),
        Y: Float64Array.from(events.map((e) => e[1])),
      };
      const { masks } = applyGatingStrategy(res.gates, res.populations, res.root_population_id,
        { n: events.length, column: (ch: string) => cols[ch] });
      const out: Record<string, number> = {};
      for (const [pid, pop] of Object.entries(res.populations)) {
        const m = (masks as Record<string, Uint8Array>)[pid];
        if (m && pid !== res.root_population_id) out[(pop as unknown as { name: string }).name] = m.reduce((a, b) => a + b, 0);
      }
      return out;
    };

    it("excludes the named population's live gate when all its ancestors are the NOT's too", () => {
      // B sits under P, and the NOT under Q under P: inside Q, NOT (P and B) is NOT B.
      const xml = synthetic(box("P", "p1", 20, 20, box("Q", "q1", 15, 20, not("N", "P/B")) + box("B", "b1", 10, 10)));
      const out = flowJoWorkspaceToGatingML(xml, 0);
      expect(out.warnings).toEqual([]);
      expect(out.gatingMl).not.toContain('gating:id="stale"');
      // FlowJo's N inside Q = {(12,5), (2,2)} minus B = {(12,5)}; the copy would also keep (5,5).
      expect(counts(out.gatingMl)).toMatchObject({ P: 4, Q: 3, B: 2, N: 1 });
      const res = importGatingML(out.gatingMl, ["X", "Y"], {}, "flow");
      const pops = Object.values(res.populations) as unknown as Array<{ population_id: string; name: string; parent_id: string | null; gate_refs: Array<{ gate_id: string; include: boolean }> }>;
      const n = pops.find((p) => p.name === "N")!;
      expect(n.parent_id).toBe(pops.find((p) => p.name === "Q")!.population_id);
      expect(n.gate_refs).toEqual([{ gate_id: pops.find((p) => p.name === "B")!.gate_refs[0].gate_id, include: false }]);
    });

    it("excludes the named population's gate alone when an ancestor of it is not above the NOT", () => {
      // B sits under R, which is not above the NOT, and B's gate reaches past R: (12, 5) is in
      // B's gate but not in R. FlowJo's N inside Q = {(5,5), (12,5), (2,2)} minus B's gate = {}.
      // Excluding B with its ancestry would have kept (12, 5), and this was refused as an OR.
      const xml = synthetic(box("P", "p1", 20, 20,
        box("Q", "q1", 15, 20, not("N", "P/R/B", box("UnderN", "u1", 20, 20))) + box("R", "r1", 11, 20, box("B", "b1", 13, 10))));
      const out = flowJoWorkspaceToGatingML(xml, 0);
      expect(out.warnings).toEqual([]);
      expect(out.gatingMl).not.toContain('gating:id="stale"');
      expect(counts(out.gatingMl)).toEqual({ P: 4, Q: 3, R: 2, B: 2, N: 0, UnderN: 0 });
      const res = importGatingML(out.gatingMl, ["X", "Y"], {}, "flow");
      const pops = Object.values(res.populations) as unknown as Array<{ population_id: string; name: string; parent_id: string | null; gate_refs: Array<{ gate_id: string; include: boolean }> }>;
      const n = pops.find((p) => p.name === "N")!;
      expect(n.parent_id).toBe(pops.find((p) => p.name === "Q")!.population_id);
      expect(n.gate_refs).toEqual([{ gate_id: pops.find((p) => p.name === "B")!.gate_refs[0].gate_id, include: false }]);
    });

    it("does not read the stored copy of a named intersection either", () => {
      const xml = synthetic(box("P", "p1", 20, 20,
        box("A", "a1", 10, 10) + box("B", "b1", 12, 12) +
        `<AndNode name="AB" count="1"><Dependents><Dependent name="P/A"/><Dependent name="P/B"/></Dependents></AndNode>` +
        not("AB-", "P/AB")));
      const out = flowJoWorkspaceToGatingML(xml, 0);
      const said = out.warnings.join("\n");
      expect(said).toMatch(/"AB-" is a complement that was skipped: "AB" is an intersection, whose complement is a union/);
      expect(said).not.toMatch(/stored inside it/);
      expect(Object.keys(counts(out.gatingMl))).not.toContain("AB-");
    });

    // T sits beneath "AB-", a complement of an intersection, which is refused with its subtree.
    // A NOT naming T elsewhere, and an intersection built on that NOT, were emitted naming a gate
    // that had gone, and the import dropped them without a word; then they were refused by name.
    // FlowJo counts the NOT as its container minus T's gate alone, whatever became of T, so T's
    // gate is imported as the NOT's own and both are kept -- whichever comes first in the document.
    const refusedBranch = box("A", "a1", 10, 10) + box("B", "b1", 12, 12) +
      `<AndNode name="AB" count="1"><Dependents><Dependent name="P/A"/><Dependent name="P/B"/></Dependents></AndNode>` +
      not("AB-", "P/AB", box("T", "t1", 5, 5, box("UnderT", "ut1", 5, 5)));
    const namingBranch = box("Q", "q1", 15, 20,
      not("T-", "P/AB-/T", box("UnderT-", "un1", 20, 20)) + box("R", "r1", 14, 20) +
      `<AndNode name="R and T-" count="1"><Dependents><Dependent name="P/Q/R"/><Dependent name="P/Q/T-"/></Dependents></AndNode>`);
    for (const [order, inner] of [["after", refusedBranch + namingBranch], ["before", namingBranch + refusedBranch]] as const) {
      it(`imports by T's gate alone a NOT naming T, which went with a refused node in another branch (${order} it)`, () => {
        const out = flowJoWorkspaceToGatingML(synthetic(box("P", "p1", 20, 20, inner)), 0);
        const said = out.warnings.join("\n");
        expect(said).toMatch(/"AB-" is a complement that was skipped: "AB" is an intersection.*; the 2 population\(s\) beneath it went with it\./);
        expect(said).toContain('"T-" is the complement of "T", which went with "AB-" when that was skipped. FlowJo excludes ' +
          'that population\'s gate alone, so the gate was imported as "T-"\'s own, and "T-" was kept; the copy of the gate ' +
          "FlowJo stored inside it differs from the current one, and was not used.");
        expect(said).not.toContain("R and T-");
        expect(out.gatingMl).not.toContain('gating:id="stale"');
        // Inside Q = {(5,5), (12,5), (2,2)}, T- is Q minus T's gate (0-5 by 0-5) = {(12,5)}, and so
        // is R and T-; the stored copy (0-3 by 0-3) would also have kept (5,5).
        expect(counts(out.gatingMl)).toEqual({ P: 4, A: 2, B: 3, AB: 2, Q: 3, R: 3, "T-": 1, "UnderT-": 1, "R and T-": 1 });
      });
    }

    it("imports such a NOT in another tree by T's gate alone when the trees are merged, as it is alone", () => {
      // The per-file import merges a sample's trees. A NOT in the second tree -- nested, and at the
      // top level, where it is the whole tree -- names T beneath "AB-" in the first. Imported with
      // its own tree alone it was the exclusion of T's gate; merged, it was refused.
      const xml = synthetic(box("P", "p1", 20, 20, refusedBranch) +
        box("S", "s1", 20, 20, not("T- nested", "P/AB-/T")) +
        not("T- top", "P/AB-/T", box("UnderTop", "ut2", 20, 20)));
      const merged = flowJoWorkspaceToGatingML(xml, 0, null);
      const said = merged.warnings.join("\n");
      expect(said).toContain('"T- nested" is the complement of "T", which went with "AB-" when that was skipped.');
      expect(said).toContain('"T- top" is the complement of "T", which went with "AB-" when that was skipped.');
      // Everything but (25,25) is in S; T's gate holds (5,5) and (2,2).
      const both = counts(merged.gatingMl);
      expect(both).toMatchObject({ S: 4, "T- nested": 2, "T- top": 3, UnderTop: 2 });
      expect(counts(flowJoWorkspaceToGatingML(xml, 0, 1).gatingMl)).toEqual({ S: 4, "T- nested": 2 });
      expect(counts(flowJoWorkspaceToGatingML(xml, 0, 2).gatingMl)).toEqual({ "T- top": 3, UnderTop: 2 });
    });

    it("imports a chain of NOTs below one naming such a population, each by its own gate alone", () => {
      // N1 names T, which went with "AB-"; UnderN1 lies beneath N1, and N2, in another branch, names
      // UnderN1. N1 was refused, UnderN1 went with it, and so did N2 and the intersection built on
      // N2, though FlowJo counts each of them. Each is now imported by its gate alone.
      const xml = synthetic(box("P", "p1", 20, 20, refusedBranch +
        box("Q", "q1", 15, 20, not("N1", "P/AB-/T", box("UnderN1", "un1", 14, 20))) +
        box("S", "s1", 20, 20, not("N2", "P/Q/N1/UnderN1") + box("R2", "r2", 20, 10) +
          `<AndNode name="R2 and N2" count="1"><Dependents><Dependent name="P/S/R2"/><Dependent name="P/S/N2"/></Dependents></AndNode>`)));
      const out = flowJoWorkspaceToGatingML(xml, 0);
      expect(out.warnings.join("\n")).not.toMatch(/"(N1|N2|R2 and N2)" is (a complement|an intersection) that was skipped/);
      // N1 = Q minus T's gate = {(12,5)}; UnderN1 = {(12,5)}; N2 = S minus UnderN1's gate (0-14 by
      // 0-20) = {(18,5)}; R2 inside S = {(5,5), (12,5), (18,5), (2,2)}; R2 and N2 = {(18,5)}.
      expect(counts(out.gatingMl)).toMatchObject({ Q: 3, N1: 1, UnderN1: 1, S: 4, N2: 1, R2: 4, "R2 and N2": 1 });
    });

    it("names what it still refuses, and imports the rest, when a NOT names a stored copy that went", () => {
      // "Gone-" lies beneath "AB-" and names a population nowhere in the sample, so its stored copy
      // stands for it. N3 names "Gone-": the copy was emitted all the same, under a container that
      // had gone, and the whole import was refused over it.
      const xml = synthetic(box("P", "p1", 20, 20,
        box("A", "a1", 10, 10) + box("B", "b1", 12, 12) +
        `<AndNode name="AB" count="1"><Dependents><Dependent name="P/A"/><Dependent name="P/B"/></Dependents></AndNode>` +
        not("AB-", "P/AB", not("Gone-", "Nowhere")) +
        box("Q", "q1", 15, 20, not("N3", "P/AB-/Gone-"))));
      const out = flowJoWorkspaceToGatingML(xml, 0);
      // "which went with "AB-", skipped" had nothing for "skipped" to attach to.
      expect(out.warnings.join("\n")).toContain('"N3" is a complement that was skipped: it depends on "Gone-", which went with "AB-" when that was skipped.');
      expect(Object.keys(counts(out.gatingMl)).sort()).toEqual(["A", "AB", "B", "P", "Q"]);
    });

    // T lies beneath a node that is skipped before any intersection is resolved: an OR, or a
    // population whose gate cannot be read. Imported with the NOT's tree alone, T is in another
    // tree and the NOT is Q minus T's gate; merged, as a per-file import merges a sample's trees,
    // the same NOT was refused ("T" was itself skipped). The mode decided the result.
    const orBranch = box("P", "p1", 20, 20, box("A", "a1", 10, 10) + box("B", "b1", 12, 12) +
      `<OrNode name="X" count="1"><Subpopulations>${box("T", "t1", 5, 5)}</Subpopulations>` +
      `<Dependents><Dependent name="P/A"/><Dependent name="P/B"/></Dependents></OrNode>`);
    const unreadBranch = box("P", "p1", 20, 20,
      `<Population name="X" count="1"><Gate><gating:QuadrantGate xmlns:gating="${G}" gating:id="qx"/></Gate>` +
      `<Subpopulations>${box("T", "t1", 5, 5)}</Subpopulations></Population>`);
    for (const [what, branch] of [["an OR", orBranch], ["a population whose gate cannot be read", unreadBranch]] as const) {
      it(`imports a NOT naming T beneath ${what} by T's gate alone, merged with that tree or not`, () => {
        const xml = synthetic(branch + box("Q", "q1", 15, 20, not("N", "P/X/T", box("UnderN", "un1", 20, 20))));
        const merged = flowJoWorkspaceToGatingML(xml, 0, null);
        const said = merged.warnings.join("\n");
        expect(said).not.toMatch(/"N" is a complement that was skipped/);
        expect(said).toContain('"N" is the complement of "T", which went with "X" when that was skipped. FlowJo excludes ' +
          'that population\'s gate alone, so the gate was imported as "N"\'s own, and "N" was kept');
        expect(merged.gatingMl).not.toContain('gating:id="stale"');
        // Q = {(5,5), (12,5), (2,2)} minus T's gate (0-5 by 0-5) = {(12,5)}, alone and merged.
        expect(counts(merged.gatingMl)).toMatchObject({ Q: 3, N: 1, UnderN: 1 });
        expect(counts(flowJoWorkspaceToGatingML(xml, 0, 1).gatingMl)).toEqual({ Q: 3, N: 1, UnderN: 1 });
      });
    }

    it("keeps an intersection on a NOT whose population went when the first NOT standing in for it goes too", () => {
      // N1 and N2 each name T, which went with X. N1 lies beneath Y, an intersection refused later
      // (it names Kp, which went with X too). SZ names N2 in its own branch; it was pointed at N1,
      // the first stand-in in document order, and refused with it: "depends on "N1", which went
      // with "Y"", though it names no N1. With S placed first it imported.
      const refusedX = box("R", "r1", 11, 20, box("A", "a1", 10, 10) +
        `<AndNode name="X" count="1"><Subpopulations>${box("T", "t1", 5, 5) + not("Kp", "P/R/Nothing")}</Subpopulations>` +
        `<Dependents><Dependent name="P/R/A"/><Dependent name="P/R/Nope"/></Dependents></AndNode>`);
      const q = box("Q", "q1", 15, 20, box("Z", "z1", 20, 20) + not("K", "P/R/X/Kp") +
        `<AndNode name="Y" count="1"><Subpopulations>${not("N1", "P/R/X/T")}</Subpopulations>` +
        `<Dependents><Dependent name="P/Q/Z"/><Dependent name="P/Q/K"/></Dependents></AndNode>`);
      const s = box("S", "s1", 20, 20, box("Z2", "z2", 20, 20) + not("N2", "P/R/X/T") +
        `<AndNode name="SZ" count="1"><Dependents><Dependent name="P/S/Z2"/><Dependent name="P/S/N2"/></Dependents></AndNode>`);
      for (const inner of [refusedX + q + s, s + refusedX + q]) {
        const out = flowJoWorkspaceToGatingML(synthetic(box("P", "p1", 20, 20, inner)), 0);
        const said = out.warnings.join("\n");
        expect(said).not.toMatch(/"SZ" is an intersection that was skipped/);
        // N1 went with Y, as Y's refusal says; it is not also said to have been kept.
        expect(said).toMatch(/"Y" is an intersection that was skipped: .*; the 1 population\(s\) beneath it went with it\./);
        expect(said).not.toContain('"N1" was kept');
        // S = {(5,5), (12,5), (18,5), (2,2)} minus T's gate = {(12,5), (18,5)}; so is SZ.
        const c = counts(out.gatingMl);
        expect(c).toMatchObject({ S: 4, N2: 2, SZ: 2 });
        expect(Object.keys(c)).not.toContain("N1");
      }
    });

    it("names an intersection on such a NOT as dropped when another file's tree is the tree", () => {
      // A per-file import takes one file's strategy as the tree. The other file's intersection on a
      // NOT whose population went -- a population with no gate of its own -- was lost from it, and
      // the result named only gates ("not in the tree, dropped: N").
      const plain = synthetic(box("P", "p1", 20, 20, box("Q", "q1", 15, 20, box("R", "r1", 14, 20))));
      const own = synthetic(box("P", "p1", 20, 20, refusedBranch + box("Q", "q1", 15, 20, box("R", "r1", 14, 20) + not("N", "P/AB-/T") +
        `<AndNode name="R and N" count="1"><Dependents><Dependent name="P/Q/R"/><Dependent name="P/Q/N"/></Dependents></AndNode>`)));
      const strategy = (xml: string) => {
        const res = importGatingML(flowJoWorkspaceToGatingML(xml, 0).gatingMl, ["X", "Y"], {}, "flow");
        return { gates: res.gates, gate_order: res.gate_order, populations: res.populations, root_population_id: res.root_population_id };
      };
      const plan = planOneTreeImport(
        [{ fileId: "f1", fileName: "D1.fcs", tree: strategy(plain) }, { fileId: "f2", fileName: "D2.fcs", tree: strategy(own) }],
        { templateId: "main", name: "Imported", leadFileId: "f1", existing: [] },
      );
      expect(plan.differing).toHaveLength(1);
      expect(plan.differing[0].dropped).toEqual(expect.arrayContaining(["N", "R and N"]));
      expect(describeDiffering(plan.differing)).toContain("R and N");
    });

    it("does not say a stored copy was used for a NOT that went with a refused node", () => {
      // K lies beneath the refused X and names a population nowhere in the sample; N names K. K
      // went with X and its copy was never imported, but the result said "the copy of the gate
      // FlowJo stored inside it was used instead".
      const xml = synthetic(box("P", "p1", 20, 20,
        box("R", "r1", 11, 20, box("A", "a1", 12, 12) +
          `<AndNode name="X" count="1"><Subpopulations>${not("K", "P/R/Nothing")}</Subpopulations>` +
          `<Dependents><Dependent name="P/R/A"/><Dependent name="P/R/Nope"/></Dependents></AndNode>`) +
        box("Q", "q1", 15, 20, not("N", "P/R/X/K", box("UnderN", "un1", 20, 20)))));
      const out = flowJoWorkspaceToGatingML(xml, 0);
      const said = out.warnings.join("\n");
      expect(said).toContain('"N" is a complement that was skipped: it depends on "K", which went with "X" when that was skipped');
      expect(said).not.toMatch(/"K" is the complement of a population that could not be read/);
      expect(said).not.toMatch(/stored inside it was used instead/);
      expect(Object.keys(counts(out.gatingMl)).sort()).toEqual(["A", "P", "Q", "R"]);
    });

    it("excludes a top-level population of another tree from a NOT nested in the tree imported", () => {
      // A has no ancestors, so NOT A inside P is P minus A's current gate, whichever tree A is in.
      const xml = synthetic(box("A", "a1", 10, 10) + box("P", "p1", 20, 20, not("N", "A")));
      const out = flowJoWorkspaceToGatingML(xml, 0, 1);
      expect(out.warnings.join("\n")).toMatch(/"N" is the complement of "A", a gate in another of this sample's trees.*differs from the current one/);
      expect(out.gatingMl).not.toContain('gating:id="stale"');
      // FlowJo's N inside P = {(5,5), (12,5), (18,5), (2,2)} minus A = {(12,5), (18,5)}.
      expect(counts(out.gatingMl)).toEqual({ P: 4, N: 2 });
      // The same membership as the merged import, where the complement is derived from A.
      expect(counts(flowJoWorkspaceToGatingML(xml, 0, null).gatingMl)).toMatchObject({ P: 4, N: 2 });
    });
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
      .toMatch(/2 independent gating trees.*Choose one to import it alone\./);
    // The caller says what can be done where no tree can be chosen, as under a per-file import.
    expect(flowJoWorkspaceToGatingML(xml, 0, null, "Open it again to choose one.").warnings.join(" "))
      .toMatch(/2 independent gating trees .*kept apart\. Open it again to choose one\.$/);
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
  // The vertices no longer pass through untouched. Evaluated continuously (the import option
  // off), FlowJo's raw vertices are moved into the axis's DISPLAY space and the transform is
  // recorded on the gate. What must hold is that the move is exact and reversible: inverting
  // the transform the file declares recovers FlowJo's original raw coordinate.
  it.runIf(has)("moves the vertices into the declared space, reversibly", { timeout: 60000 }, () => {
    const out = flowJoWorkspaceToGatingML(wsp(), lp4Index(), null, undefined, { flowJoGrid: false });
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

  // On FlowJo's grid the vertices go onto integer channels, which no inverse can take back to
  // FlowJo's exact coordinates, so the raw vertices ride along on the gate for the way back out.
  it.runIf(has)("puts the vertices on FlowJo's channels and keeps FlowJo's own beside them", { timeout: 60000 }, () => {
    const out = flowJoWorkspaceToGatingML(wsp(), lp4Index());
    const doc = new DOMParser().parseFromString(out.gatingMl, "application/xml");
    const gate = Array.from(doc.getElementsByTagName("*")).find((el) => el.localName === "PolygonGate")!;
    const marker = Array.from(gate.getElementsByTagName("*")).find((el) => el.localName === WSP_GATE_SPACE_TAG)!;
    const space = JSON.parse(marker.textContent!) as { x: TransformSpec; y: TransformSpec; raw: number[][] };
    expect(space.x.kind).toBe("flowjoChannels");
    expect(space.y.kind).toBe("flowjoChannels");
    const written: number[][] = [];
    for (const v of Array.from(gate.getElementsByTagName("*"))) {
      if (v.localName !== "vertex") continue;
      const cs = Array.from(v.getElementsByTagName("*")).filter((c) => c.localName === "coordinate");
      written.push(cs.map((c) => Number(c.getAttribute("data-type:value"))));
    }
    expect(written.flat().every(Number.isInteger)).toBe(true);
    expect(space.raw).toHaveLength(written.length);
    expect(space.raw.some((v) => Math.abs(v[0] - 30887444.5705699) < 1e-3)).toBe(true);
    expect(space.raw.some((v) => Math.abs(v[1] - 759668.2975150499) < 1e-3)).toBe(true);
    expect(out.gridPolygons).toBeGreaterThan(0);
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

  it("degrades a logicle no logicle scale has, and an ArcSinh whose scale overflows, to warned straight-in-raw (verifier)", () => {
    // The reference logicle and Transformations.v2.0.xsd bound W by M/2 and A by M − 2W, and
    // GateLab's logicle takes A >= 0; GateLab's Gating-ML reader refuses the rest. Carried from a
    // workspace, such a gate was written with those parameters, and GateLab refused its own export.
    const logicle = (W: number, M: number, A: number) => (p: string) =>
      `<transforms:logicle transforms:T="262144" transforms:W="${W}" transforms:M="${M}" transforms:A="${A}">
         <data-type:parameter data-type:name="${p}"/></transforms:logicle>`;
    // FlowJo's ArcSinh is held as asinh(x / c) with c = T / sinh(M ln 10), which is 0 where sinh overflows.
    const arcsinh = (M: number) => (p: string) =>
      `<transforms:fasinh transforms:T="262144" transforms:M="${M}" transforms:A="0" transforms:length="256" transforms:maxRange="262144">
         <data-type:parameter data-type:name="${p}"/></transforms:fasinh>`;
    for (const [tr, kind] of [[logicle(1, 4.5, 3.3), "logicle"], [logicle(3, 4.5, 0), "logicle"], [logicle(0.5, 4.5, -0.5), "logicle"], [arcsinh(400), "fasinh"]] as const) {
      const out = flowJoWorkspaceToGatingML(syntheticWithTransforms(tr("X") + tr("Y"), polygonPop("A", "g1")), 0);
      expect(out.gatingMl, kind).not.toContain(WSP_GATE_SPACE_TAG);
      expect(out.warnings.join(" ")).toMatch(new RegExp(kind));
      expect(out.warnings.join(" ")).toMatch(/RAW space/);
    }
    // A = M − 2W and W = M/2 are logicle scales, and are carried; so is an ArcSinh short of overflow.
    for (const tr of [logicle(1, 4.5, 2.5), logicle(2.25, 4.5, 0), arcsinh(300)]) {
      const out = flowJoWorkspaceToGatingML(syntheticWithTransforms(tr("X") + tr("Y"), polygonPop("A", "g1")), 0);
      expect(out.gatingMl).toContain(WSP_GATE_SPACE_TAG);
    }
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

  // A histogram's range has one dimension, so gateAxisNames found no pair and the step was skipped:
  // FR-FCM-ZYKL's seven Time ranges were read in seconds as ticks.
  it("returns a Time range (one dimension) from seconds to ticks too, under either answer", () => {
    const rangePop = `<Population name="Time range" count="10"><Gate>
      <gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="r1">
        <gating:dimension gating:min="10" gating:max="50"><data-type:fcs-dimension data-type:name="Time"/></gating:dimension>
      </gating:RectangleGate></Gate></Population>`;
    const xml = sampleWith(`<Keyword name="$FIL" value="s.fcs"/><Keyword name="$TIMESTEP" value="0.01"/>`, rangePop);
    for (const flowJoGrid of [true, false]) {
      const out = flowJoWorkspaceToGatingML(xml, 0, null, undefined, { flowJoGrid });
      const [time] = rectangleRanges(out.gatingMl, "r1");
      expect(time[0]).toBeCloseTo(1000, 9);
      expect(time[1]).toBeCloseTo(5000, 9);
    }
    // No $TIMESTEP: the bound is left as FlowJo saved it.
    const bare = flowJoWorkspaceToGatingML(sampleWith(`<Keyword name="$FIL" value="s.fcs"/>`, rangePop), 0);
    expect(rectangleRanges(bare.gatingMl, "r1")).toEqual([[10, 50]]);
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

// FlowJo moves an event that falls outside a linear axis's range onto that axis's edge before it
// tests a gate. On FR-FCM-Z2V4 d_021 the debris rectangle's SSC edge is the axis floor and its
// FSC edge below it, so the file's end-of-run events with negative scatter are debris to FlowJo
// (994) and were not to GateLab (901). The importer now opens a rectangle edge at the axis range.
describe("an event beyond a linear axis's range, as FlowJo places it", () => {
  const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";
  const linear = (name: string, gain = "1", max = "262144") =>
    `<transforms:linear xmlns:transforms="${T}" xmlns:data-type="${D}" transforms:minRange="0" transforms:maxRange="${max}" transforms:gain="${gain}">` +
    `<data-type:parameter data-type:name="${name}"/></transforms:linear>`;
  const rect = (x: string, xMin: number, xMax: number, y: string, yMin: number, yMax: number) =>
    `<gating:RectangleGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="r1">
      <gating:dimension gating:min="${xMin}" gating:max="${xMax}"><data-type:fcs-dimension data-type:name="${x}"/></gating:dimension>
      <gating:dimension gating:min="${yMin}" gating:max="${yMax}"><data-type:fcs-dimension data-type:name="${y}"/></gating:dimension>
    </gating:RectangleGate>`;
  const wspWith = (transforms: string, gate: string) => `<Workspace><SampleList><Sample>
    <Transformations>${transforms}</Transformations>
    <SampleNode name="D1.fcs" count="6"><Subpopulations>
      <Population name="debris" count="4"><Gate>${gate}</Gate></Population>
      <NotNode name="debris-" count="2"><Dependents><Dependent name="debris"/></Dependents></NotNode>
    </Subpopulations></SampleNode></Sample></SampleList></Workspace>`;
  // Inside; SSC below the axis; both far below; FSC far below with SSC in range; FSC above the
  // gate; FSC above the axis.
  const events: Array<[number, number]> = [[100, 100], [5000, -50], [-5e6, -6e6], [-5e6, 5000], [20000, 100], [3e5, 100]];
  const counts = (xml: string, x = "FSC-A", y = "SSC-A"): Record<string, number> => {
    const res = importGatingML(flowJoWorkspaceToGatingML(xml, 0).gatingMl, [x, y], {}, "flow");
    const cols: Record<string, Float64Array> = {
      [x]: Float64Array.from(events.map((e) => e[0])),
      [y]: Float64Array.from(events.map((e) => e[1])),
    };
    const { masks } = applyGatingStrategy(res.gates, res.populations, res.root_population_id,
      { n: events.length, column: (ch: string) => cols[ch] });
    const out: Record<string, number> = {};
    for (const [pid, pop] of Object.entries(res.populations)) {
      const m = (masks as Record<string, Uint8Array>)[pid];
      if (m && pid !== res.root_population_id) out[(pop as unknown as { name: string }).name] = m.reduce((a, b) => a + b, 0);
    }
    return out;
  };
  const debris = rect("FSC-A", -8916.46, 16049.63, "SSC-A", 0, 69697.02);

  it("counts an event below the axis inside a rectangle whose edge is at or beyond the axis floor", () => {
    expect(counts(wspWith(linear("FSC-A") + linear("SSC-A"), debris))).toEqual({ debris: 4, "debris-": 2 });
  });

  it("leaves an edge inside the axis range, and an axis above its range, as they were", () => {
    // The gate's FSC max is inside the range: the event above the axis is still outside.
    const inner = rect("FSC-A", 10, 16049.63, "SSC-A", 10, 69697.02);
    expect(counts(wspWith(linear("FSC-A") + linear("SSC-A"), inner))).toEqual({ debris: 1, "debris-": 5 });
    // A max at the axis top takes the event above it.
    const top = rect("FSC-A", 10, 262144, "SSC-A", 10, 69697.02);
    expect(counts(wspWith(linear("FSC-A") + linear("SSC-A"), top))).toEqual({ debris: 3, "debris-": 3 });
  });

  // Opening a far edge is right only when the axis edge lies inside the rectangle. A rectangle
  // wholly below the floor holds nothing under FlowJo's rule; opening its min made it take every
  // raw event below its max (both far-below events here), where FlowJo counts none.
  it("does not open an edge of a rectangle lying wholly beyond the axis range, and says so", () => {
    const below = rect("FSC-A", -1e6, -100, "SSC-A", -1e7, 69697.02);
    const xml = wspWith(linear("FSC-A") + linear("SSC-A"), below);
    expect(counts(xml)).toEqual({ debris: 0, "debris-": 6 });
    expect(flowJoWorkspaceToGatingML(xml, 0).warnings.join("\n"))
      .toMatch(/"debris" lies wholly beyond the FSC-A axis range \(0 to 262144\)\. FlowJo places every event beyond the range on the axis edge, so it counts none inside this gate/);
    // In the language the app is in, beside its sibling "lies wholly below", when it passes its translation.
    const ja = flowJoWorkspaceToGatingML(xml, 0, null, undefined, { flowJoGrid: true, translate: (text, values) => translateUi("ja", text, values) }).warnings.join("\n");
    expect(ja).toContain("「debris」はFSC-A軸の範囲（0から262144）より完全に外側にあります。");
    expect(ja).not.toContain("lies wholly beyond");
    // Beyond the top, likewise: opening its max took the event at 3e5, above the gate too.
    const above = rect("FSC-A", 2.7e5, 2.9e5, "SSC-A", 10, 69697.02);
    expect(counts(wspWith(linear("FSC-A") + linear("SSC-A"), above))).toEqual({ debris: 0, "debris-": 6 });
  });

  it("does not apply the rule where it was not measured: a scaled axis, or no declared range", () => {
    expect(counts(wspWith(linear("FSC-A", "2") + linear("SSC-A", "2"), debris))).toEqual({ debris: 1, "debris-": 5 });
    expect(counts(wspWith("", debris))).toEqual({ debris: 1, "debris-": 5 });
  });
});

// FlowJo 7 writes its gates in Gating-ML 1.5's namespaces, with a dimension naming its parameter
// by data-type:parameter. GateLab read the sample list (every element FlowJo names itself) but none
// of the gates, and said only that the other samples had no FCS: FR-FCM-ZYB7's T7_workspace.wsp
// (FlowJo 7.6.2) opened with its sample confirmed by $TOT, $DATE, $BTIM, $ETIM and GUID and no
// population (the release candidate's browser verifier; master the same). Synthetic names.
describe("a FlowJo 7 workspace", () => {
  const flowJo7 = (version: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version="1.61" flowJoVersion="${version}" xmlns:gating="http://www.isac-net.org/std/Gating-ML/v1.5/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v1.5/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v1.5/datatypes" xmlns:comp="http://www.isac-net.org/std/Gating-ML/v1.5/compensation">
  <SampleList><Sample><DataSet uri=".\\D1.fcs" sampleID="1"/>
    <SampleNode name="D1.fcs" count="100" sampleID="1"><Subpopulations>
      <Population name="CD4_positive" count="40"><Gate gating:id="ID1">
        <gating:PolygonGate eventsInside="1" isFJGate="1" isQuad="0">
          <gating:dimension><data-type:parameter data-type:name="FSC-A"/></gating:dimension>
          <gating:dimension><data-type:parameter data-type:name="SSC-A"/></gating:dimension>
          <gating:vertex><gating:coordinate data-type:value="10"/><gating:coordinate data-type:value="10"/></gating:vertex>
          <gating:vertex><gating:coordinate data-type:value="90"/><gating:coordinate data-type:value="10"/></gating:vertex>
          <gating:vertex><gating:coordinate data-type:value="50"/><gating:coordinate data-type:value="90"/></gating:vertex>
        </gating:PolygonGate></Gate></Population>
    </Subpopulations></SampleNode>
  </Sample></SampleList>
</Workspace>`;

  it("is refused by name, with the FlowJo version and what to do, rather than opened with no gates", () => {
    for (const version of ["7.6.2", "7.6.5"]) {
      expect(isFlowJoWorkspace(flowJo7(version))).toBe(true);
      expect(() => listFlowJoWorkspaceSamples(flowJo7(version)))
        .toThrow(new RegExp(`FlowJo ${version.replace(/\./g, "\\.")}.*Gating-ML 1\\.5.*FlowJo 10`));
      expect(() => flowJoWorkspaceToGatingML(flowJo7(version), 0, null)).toThrow(/Gating-ML 1\.5/);
    }
  });

  // The refusal was English with the interface in Japanese (the release candidate's verifier).
  it("is refused in the interface's language", () => {
    const ja = (text: string, values?: Record<string, string | number>) => translateUi("ja", text, values);
    expect(() => listFlowJoWorkspaceSamples(flowJo7("7.6.2"), ja)).toThrow(/FlowJo 7\.6\.2 で保存されており.*Gating-ML 1\.5/);
    expect(() => flowJoWorkspaceToGatingML(flowJo7("7.6.2"), 0, null, undefined, { translate: ja })).toThrow(/で保存されており/);
    expect(() => listFlowJoWorkspaceSamples(flowJo7("7.6.2").replace(' flowJoVersion="7.6.2"', ""), ja)).toThrow(/FlowJo 10 より前のバージョン/);
  });
});

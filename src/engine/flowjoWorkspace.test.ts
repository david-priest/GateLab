// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isFlowJoWorkspace,
  listFlowJoWorkspaceSamples,
  flowJoWorkspaceToGatingML,
} from "./flowjoWorkspace";
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

  it.runIf(has)("lists the real workspace's samples", () => {
    const samples = listFlowJoWorkspaceSamples(wsp());
    expect(samples.length).toBe(24);
    const lp4 = samples.find((s) => s.name === "LP4 rec.fcs")!;
    expect(lp4.eventCount).toBe(50000);
    expect(lp4.gateCount).toBe(12);
    expect(lp4.unsupportedCount).toBe(0);
  });

  it.runIf(has)("rebuilds the LP4 hierarchy end to end, through importGatingML", () => {
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
  it.runIf(has)("preserves the vertices exactly", () => {
    const out = flowJoWorkspaceToGatingML(wsp(), lp4Index());
    expect(out.gatingMl).toContain("30887444.5705699");
    expect(out.gatingMl).toContain("759668.2975150499");
  });
});

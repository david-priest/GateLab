// @vitest-environment jsdom
// Logicle's parameter bounds, W <= M/2 and A <= M - 2W, compared with room for the rounding of a
// decimal written on the bound, in the Gating-ML reader and the FlowJo workspace reader alike.
import { describe, it, expect } from "vitest";
import { importGatingML } from "./gatingml";
import { flowJoWorkspaceToGatingML, WSP_GATE_SPACE_TAG } from "./flowjoWorkspace";

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";

/** A Gating-ML range on PE-A under a logicle with these parameters, written as given. */
function gatingMl(W: string, M: string, A: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <gating:Gating-ML xmlns:gating="${G}" xmlns:data-type="${D}" xmlns:transforms="${T}">
      <transforms:transformation transforms:id="Tr">
        <transforms:logicle transforms:T="262144" transforms:W="${W}" transforms:M="${M}" transforms:A="${A}"/>
      </transforms:transformation>
      <gating:RectangleGate gating:id="R" gating:name="Gate R">
        <gating:dimension gating:min="0.2" gating:max="0.8" gating:transformation-ref="Tr"><data-type:fcs-dimension data-type:name="PE-A"/></gating:dimension>
      </gating:RectangleGate>
    </gating:Gating-ML>`;
}

/** A FlowJo workspace whose one polygon is on X and Y, both displayed under this logicle. */
function workspace(W: string, M: string, A: string): string {
  const logicle = (p: string) => `<transforms:logicle transforms:T="262144" transforms:W="${W}" transforms:M="${M}" transforms:A="${A}">
      <data-type:parameter data-type:name="${p}"/></transforms:logicle>`;
  return `<Workspace xmlns:transforms="${T}" xmlns:data-type="${D}">
    <SampleList><Sample>
      <Transformations>${logicle("X")}${logicle("Y")}</Transformations>
      <SampleNode name="s.fcs" count="100"><Subpopulations>
        <Population name="A" count="10"><Gate>
          <gating:PolygonGate xmlns:gating="${G}" xmlns:data-type="${D}" gating:id="g1">
            <gating:dimension><data-type:fcs-dimension data-type:name="X"/></gating:dimension>
            <gating:dimension><data-type:fcs-dimension data-type:name="Y"/></gating:dimension>
            <gating:vertex><gating:coordinate data-type:value="0"/><gating:coordinate data-type:value="0"/></gating:vertex>
            <gating:vertex><gating:coordinate data-type:value="10"/><gating:coordinate data-type:value="0"/></gating:vertex>
            <gating:vertex><gating:coordinate data-type:value="10"/><gating:coordinate data-type:value="10"/></gating:vertex>
          </gating:PolygonGate></Gate></Population>
      </Subpopulations></SampleNode>
    </Sample></SampleList></Workspace>`;
}

// Written in decimal with A at M - 2W; in double precision M - 2W comes out a unit in the last
// place below A (4.42 - 2 * 0.87 = 2.6799999999999997, 4.1 - 2 * 0.35 = 3.3999999999999995).
const ON_THE_BOUND: [string, string, string][] = [["0.87", "4.42", "2.68"], ["0.35", "4.1", "3.4"]];

describe("a logicle with A at M - 2W, written in decimal", () => {
  it("is read from a Gating-ML file", () => {
    for (const [W, M, A] of ON_THE_BOUND) {
      const res = importGatingML(gatingMl(W, M, A), ["PE-A"], {}, "flow");
      const g = Object.values(res.gates)[0];
      expect(g.transforms?.["PE-A"], `${W} ${M} ${A}`).toMatchObject({ kind: "logicle", W: Number(W), M: Number(M), A: Number(A) });
    }
  });

  it("is carried from a FlowJo workspace, and GateLab reads what it carried", () => {
    for (const [W, M, A] of ON_THE_BOUND) {
      const out = flowJoWorkspaceToGatingML(workspace(W, M, A), 0);
      expect(out.gatingMl, `${W} ${M} ${A}`).toContain(WSP_GATE_SPACE_TAG);
      expect(out.warnings.join(" ")).not.toMatch(/RAW space/);
      expect(() => importGatingML(out.gatingMl, ["X", "Y"], {}, "flow")).not.toThrow();
    }
  });

  it("is still refused where A or W is past its bound by more than rounding", () => {
    expect(() => importGatingML(gatingMl("0.87", "4.42", "2.6800001"), ["PE-A"], {}, "flow"))
      .toThrow(/logicle with A = 2\.6800001 above M - 2W/);
    expect(() => importGatingML(gatingMl("2.2500001", "4.5", "0"), ["PE-A"], {}, "flow"))
      .toThrow(/logicle with W = 2\.2500001 above M\/2/);
    const out = flowJoWorkspaceToGatingML(workspace("0.87", "4.42", "2.6800001"), 0);
    expect(out.gatingMl).not.toContain(WSP_GATE_SPACE_TAG);
    expect(out.warnings.join(" ")).toMatch(/RAW space/);
  });
});

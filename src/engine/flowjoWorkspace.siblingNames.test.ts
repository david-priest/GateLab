// @vitest-environment jsdom
// Two sibling populations of one name in a FlowJo workspace stay two populations, each with
// FlowJo's own count under its own name.
import { describe, expect, it } from "vitest";
import { flowJoWorkspaceToGatingML } from "./flowjoWorkspace";
import { importGatingML } from "./gatingml";

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";
const NS = `xmlns:gating="${G}" xmlns:transforms="${T}" xmlns:data-type="${D}"`;

describe("duplicate sibling names", () => {
  it("two siblings named alike stay two populations with their own counts", () => {
    const rect = (id: string, lo: number) => `<gating:RectangleGate gating:id="${id}">
      <gating:dimension gating:min="${lo}" gating:max="${lo + 100}"><data-type:fcs-dimension data-type:name="FL1-A"/></gating:dimension>
      <gating:dimension gating:min="0" gating:max="100"><data-type:fcs-dimension data-type:name="FL2-A"/></gating:dimension></gating:RectangleGate>`;
    const xml = `<Workspace ${NS}><SampleList><Sample><SampleNode name="S1.fcs" count="100"><Subpopulations>
      <Population name="Parent" count="90"><Gate>${rect("p", 0)}</Gate><Subpopulations>
        <Population name="CD4_positive" count="11"><Gate>${rect("a", 10)}</Gate></Population>
        <Population name="CD4_positive" count="22"><Gate>${rect("b", 500)}</Gate></Population>
      </Subpopulations></Population></Subpopulations></SampleNode></Sample></SampleList></Workspace>`;
    const conv = flowJoWorkspaceToGatingML(xml, 0, 0);
    const res = importGatingML(conv.gatingMl, ["FL1-A", "FL2-A"], {}, "flow");
    const names = Object.values(res.populations).map((p) => p.name);
    expect(Object.keys(res.gates)).toHaveLength(3);
    expect(conv.flowJoCounts).toEqual({ Parent: 90, CD4_positive: 11, "CD4_positive (2)": 22 });
    expect(names.filter((name) => name.startsWith("CD4_positive")).sort()).toEqual(["CD4_positive", "CD4_positive (2)"]);
  });
});

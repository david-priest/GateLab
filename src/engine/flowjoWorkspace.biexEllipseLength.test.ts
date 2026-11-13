// @vitest-environment jsdom
// An ellipse in a FlowJo workspace is written in 256 display channels of its axes. On a biex axis
// whose table has another length the centre is the same raw value: mid-axis is mid-axis.
import { describe, expect, it } from "vitest";
import { flowJoWorkspaceToGatingML } from "./flowjoWorkspace";
import { importGatingML } from "./gatingml";
import { transformFromSpec } from "./sample";

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";
const NS = `xmlns:gating="${G}" xmlns:transforms="${T}" xmlns:data-type="${D}"`;

describe("ellipse on a biex axis whose length is not 256", () => {
  const ws = (length: number) => `<Workspace ${NS}><SampleList><Sample><Transformations>
    ${["FL1-A", "FL2-A"].map((p) => `<transforms:biex transforms:maxRange="262144" transforms:pos="4.42" transforms:neg="0" transforms:width="-10" transforms:length="${length}"><data-type:parameter data-type:name="${p}"/></transforms:biex>`).join("")}
    </Transformations><SampleNode name="S1.fcs" count="10"><Subpopulations>
    <Population name="Blob" count="5"><Gate>
      <gating:EllipsoidGate gating:id="e1" gating:distance="40">
        <gating:dimension><data-type:fcs-dimension data-type:name="FL1-A"/></gating:dimension>
        <gating:dimension><data-type:fcs-dimension data-type:name="FL2-A"/></gating:dimension>
        <gating:foci>
          <gating:vertex><gating:coordinate data-type:value="118"/><gating:coordinate data-type:value="128"/></gating:vertex>
          <gating:vertex><gating:coordinate data-type:value="138"/><gating:coordinate data-type:value="128"/></gating:vertex>
        </gating:foci>
      </gating:EllipsoidGate></Gate></Population></Subpopulations></SampleNode></Sample></SampleList></Workspace>`;
  it("lands the centre at the same raw value whatever the table length", () => {
    const centreRaw = (length: number) => {
      const conv = flowJoWorkspaceToGatingML(ws(length), 0, 0);
      const res = importGatingML(conv.gatingMl, ["FL1-A", "FL2-A"], {}, "flow");
      const g = Object.values(res.gates)[0] as unknown as { mean: [number, number]; transforms?: Record<string, never> };
      const spec = g.transforms!["FL1-A"];
      const inv = transformFromSpec(spec).inverse;
      // forward range of the axis for reference
      const top = transformFromSpec(spec).forward(262144);
      return { meanDisplay: g.mean[0], axisTop: top, centreRaw: inv(g.mean[0]) };
    };
    const a = centreRaw(256);
    const b = centreRaw(1024);
    // FlowJo display channel 128 of 256 is mid-axis either way; the raw centre must agree.
    expect(b.centreRaw).toBeCloseTo(a.centreRaw, -1);
  });
});

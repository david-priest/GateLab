// @vitest-environment jsdom
// An ellipse on a Time axis FlowJo displays with asinh is in that transform's display channels,
// so it is placed by the axis map alone; only a linear Time axis's seconds are divided into ticks.
import { describe, expect, it } from "vitest";
import { flowJoWorkspaceToGatingML } from "./flowjoWorkspace";
import { importGatingML } from "./gatingml";
import { getGateMask } from "./gates";
import type { EllipseGate, Gate } from "./models";
import { transformFromSpec } from "./sample";

const NS = `xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"`;

const T = 262144;
const M = 4.5;
const workspace = `<Workspace ${NS}><SampleList><Sample>
  <Keywords><Keyword name="$TIMESTEP" value="0.01"/></Keywords>
  <Transformations>
  <transforms:fasinh transforms:T="${T}" transforms:M="${M}" transforms:A="0"><data-type:parameter data-type:name="Time"/></transforms:fasinh>
  <transforms:linear transforms:minRange="0" transforms:maxRange="256"><data-type:parameter data-type:name="FL1-A"/></transforms:linear>
  </Transformations><SampleNode name="S1.fcs" count="10"><Subpopulations>
  <Population name="Burst" count="5"><Gate>
    <gating:EllipsoidGate gating:id="e1" gating:distance="60">
      <gating:dimension><data-type:fcs-dimension data-type:name="Time"/></gating:dimension>
      <gating:dimension><data-type:fcs-dimension data-type:name="FL1-A"/></gating:dimension>
      <gating:foci>
        <gating:vertex><gating:coordinate data-type:value="115"/><gating:coordinate data-type:value="125"/></gating:vertex>
        <gating:vertex><gating:coordinate data-type:value="135"/><gating:coordinate data-type:value="125"/></gating:vertex>
      </gating:foci>
    </gating:EllipsoidGate></Gate></Population>
  </Subpopulations></SampleNode></Sample></SampleList></Workspace>`;

describe("a FlowJo ellipse on an asinh Time axis", () => {
  it("is centred where the axis map puts channel 125, and holds the event there", () => {
    const conv = flowJoWorkspaceToGatingML(workspace, 0, null, "", { flowJoGrid: false });
    const res = importGatingML(conv.gatingMl, ["Time", "FL1-A"], {}, "flow");
    const gate = Object.values(res.gates).find((g) => g.name === "Burst") as EllipseGate;
    // The fasinh map (A = 0): display = M ln10 / 256 per channel, with no $TIMESTEP in it.
    const centre = (M * Math.LN10 / 256) * 125;
    expect(gate.mean[0]).toBeCloseTo(centre, 9);
    expect(gate.mean[1]).toBeCloseTo(125, 9);
    // The Time value (ticks) whose asinh display is the centre, and two far from it.
    const cofactor = T / Math.sinh(M * Math.LN10);
    const atCentre = cofactor * Math.sinh(centre);
    const events: [number, number][] = [[atCentre, 125], [atCentre * 100, 125], [atCentre / 100, 125]];
    // The gate lives in display space; its columns are the events under the transforms it carries.
    expect(gate.space).toBe("display");
    const fwd = (channel: string) => transformFromSpec(gate.transforms![channel]).forward;
    const members = (g: Gate) => Array.from(getGateMask(g, {
      n: events.length,
      column: (channel: string) => Float64Array.from(events, (e) => fwd(channel)(channel === "Time" ? e[0] : e[1])),
    } as never));
    expect(members(gate)).toEqual([1, 0, 0]);
  });
});

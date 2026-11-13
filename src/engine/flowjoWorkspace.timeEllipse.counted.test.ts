// @vitest-environment jsdom
// FlowJo draws Time in seconds where the file stores ticks. A gate on Time is brought back to
// ticks: a rectangle was, and an ellipse on the same axis was left in seconds.
import { describe, expect, it } from "vitest";
import { flowJoWorkspaceToGatingML } from "./flowjoWorkspace";
import { importGatingML } from "./gatingml";
import { getGateMask } from "./gates";
import type { Gate } from "./models";

const NS = `xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"`;

const workspace = `<Workspace ${NS}><SampleList><Sample><Transformations>
  <transforms:linear transforms:minRange="0" transforms:maxRange="256" gain="0.01"><data-type:parameter data-type:name="Time"/></transforms:linear>
  <transforms:linear transforms:minRange="0" transforms:maxRange="256"><data-type:parameter data-type:name="FL1-A"/></transforms:linear>
  </Transformations><SampleNode name="S1.fcs" count="10"><Subpopulations>
  <Population name="Stable_time" count="5"><Gate><gating:RectangleGate gating:id="r1">
    <gating:dimension gating:min="100" gating:max="150"><data-type:fcs-dimension data-type:name="Time"/></gating:dimension>
    <gating:dimension gating:min="100" gating:max="150"><data-type:fcs-dimension data-type:name="FL1-A"/></gating:dimension>
  </gating:RectangleGate></Gate></Population>
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

describe("a FlowJo gate on a Time axis drawn in seconds", () => {
  it("holds the same ticks as a rectangle and as an ellipse", () => {
    const conv = flowJoWorkspaceToGatingML(workspace, 0, null, "", { flowJoGrid: false });
    const res = importGatingML(conv.gatingMl, ["Time", "FL1-A"], {}, "flow");
    const gate = (name: string): Gate => Object.values(res.gates).find((g) => g.name === name)!;
    // (Time in ticks, FL1-A): 125 s is tick 12,500. The third event is at tick 125, FL1-A 125.
    const events: [number, number][] = [[12500, 125], [20000, 125], [125, 125]];
    const members = (g: Gate) => Array.from(getGateMask(g, {
      n: events.length,
      column: (channel: string) => Float64Array.from(events, (e) => (channel === "Time" ? e[0] : e[1])),
    } as never));
    expect(members(gate("Stable_time"))).toEqual([1, 0, 0]);
    expect(members(gate("Burst"))).toEqual([1, 0, 0]);
  });
});

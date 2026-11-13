// @vitest-environment jsdom
// A sample with no matrix of its own takes the workspace's only matrix. "Only" is by content:
// FlowJo names each file's own matrix "Acquisition-defined", so two different matrices can share
// a name, and counted by name the last of them was applied to a file that had none.
import { describe, expect, it } from "vitest";
import { flowJoWorkspaceToGatingML } from "./flowjoWorkspace";

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";
const NS = `xmlns:gating="${G}" xmlns:transforms="${T}" xmlns:data-type="${D}"`;

/** FL1-A spills into FL2-A by `spill`. */
const matrix = (name: string, spill: number) => `
  <transforms:spilloverMatrix spectral="0" prefix="Comp-" suffix="" name="${name}">
    <data-type:parameters><data-type:parameter data-type:name="FL1-A"/><data-type:parameter data-type:name="FL2-A"/></data-type:parameters>
    <transforms:spillover data-type:parameter="FL1-A">
      <transforms:coefficient data-type:parameter="FL1-A" transforms:value="1"/>
      <transforms:coefficient data-type:parameter="FL2-A" transforms:value="${spill}"/>
    </transforms:spillover>
    <transforms:spillover data-type:parameter="FL2-A">
      <transforms:coefficient data-type:parameter="FL1-A" transforms:value="0"/>
      <transforms:coefficient data-type:parameter="FL2-A" transforms:value="1"/>
    </transforms:spillover>
  </transforms:spilloverMatrix>`;

const gate = `<Population name="CD4_positive" count="10"><Gate>
  <gating:RectangleGate gating:id="g1">
    <gating:dimension gating:min="100" gating:max="1000"><data-type:fcs-dimension data-type:name="Comp-FL1-A"/></gating:dimension>
    <gating:dimension gating:min="100" gating:max="1000"><data-type:fcs-dimension data-type:name="Comp-FL2-A"/></gating:dimension>
  </gating:RectangleGate></Gate></Population>`;

/** S1 and S2 with their own matrices, both copied to the Matrices block, and S3 with none. */
const workspace = (s1: number, s2: number) => `<Workspace flowJoVersion="10.9.0" ${NS}>
  <Matrices>${matrix("Acquisition-defined", s1)}${matrix("Acquisition-defined", s2)}</Matrices>
  <SampleList>
    <Sample>${matrix("Acquisition-defined", s1)}<SampleNode name="S1.fcs" count="10"><Subpopulations>${gate}</Subpopulations></SampleNode></Sample>
    <Sample>${matrix("Acquisition-defined", s2)}<SampleNode name="S2.fcs" count="10"><Subpopulations>${gate}</Subpopulations></SampleNode></Sample>
    <Sample><SampleNode name="S3.fcs" count="10"><Subpopulations>${gate}</Subpopulations></SampleNode></Sample>
  </SampleList></Workspace>`;

describe("a FlowJo sample with no matrix of its own", () => {
  it("is given none when the workspace holds two different matrices of one name", () => {
    const conv = flowJoWorkspaceToGatingML(workspace(0.1, 0.5), 2, 0);
    expect(conv.sampleName).toBe("S3.fcs");
    expect(conv.spillover).toBeNull();
    expect(conv.warnings.join(" ")).toMatch(/no usable compensation matrix/);
  });

  it("is given the workspace's matrix when every copy is the same one", () => {
    const conv = flowJoWorkspaceToGatingML(workspace(0.1, 0.1), 2, 0);
    expect(conv.spillover?.matrix.matrix).toEqual([[1, 0.1], [0, 1]]);
  });

  it("leaves each sample with a matrix of its own on that matrix", () => {
    expect(flowJoWorkspaceToGatingML(workspace(0.1, 0.5), 0, 0).spillover?.matrix.matrix).toEqual([[1, 0.1], [0, 1]]);
    expect(flowJoWorkspaceToGatingML(workspace(0.1, 0.5), 1, 0).spillover?.matrix.matrix).toEqual([[1, 0.5], [0, 1]]);
  });
});

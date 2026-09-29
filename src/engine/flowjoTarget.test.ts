// @vitest-environment jsdom
//
// A FlowJo workspace's strategy can only be imported onto the file the open paired it with. The
// import used to check ONLY the active sample and wait silently otherwise, so choosing several FCS
// at the prompt -- where the target was not the file that happened to end up active -- loaded the
// data with no gating hierarchy and gave no reason. It then found the target again by name, which
// with two loaded files of one name (Specimen_001_Tube_001.fcs from two experiments) put the
// strategy on the first of them whichever the dialog had paired. The target is now the loaded
// entry the dialog decided on, by id.

import { describe, it, expect } from "vitest";
import { resolveFlowJoTarget } from "./flowjoWorkspace";

const loaded = (...names: string[]) => names.map((name, i) => ({ id: `id${i}`, name }));

describe("resolving which loaded sample a workspace's gates belong to", () => {
  it("applies directly when the active sample is the one the strategy goes on", () => {
    const r = resolveFlowJoTarget({ entryId: "id0", names: ["D1.fcs"] }, "id0", loaded("D1.fcs"));
    expect(r).toEqual({ kind: "apply" });
  });

  it("switches to the target when it is loaded but not active", () => {
    // Three files chosen at the prompt; the strategy goes on the third.
    const files = loaded("D1.fcs", "D2.fcs", "D3.fcs");
    const r = resolveFlowJoTarget({ entryId: "id2", names: ["D3.fcs"] }, "id0", files);
    expect(r).toEqual({ kind: "switch", id: "id2" });
  });

  it("goes to the file paired by id, not the first loaded file of its name", () => {
    // Two loaded files named alike, from two experiments; the dialog paired the second.
    const files = loaded("Specimen_001_Tube_001.fcs", "Specimen_001_Tube_001.fcs");
    expect(resolveFlowJoTarget({ entryId: "id1", names: ["Specimen_001_Tube_001.fcs"] }, "id0", files))
      .toEqual({ kind: "switch", id: "id1" });
    expect(resolveFlowJoTarget({ entryId: "id1", names: ["Specimen_001_Tube_001.fcs"] }, "id1", files))
      .toEqual({ kind: "apply" });
  });

  it("reports absence, naming the file, when the paired file is not loaded", () => {
    expect(resolveFlowJoTarget({ entryId: "gone", names: ["D1.fcs"] }, "id0", loaded("D2.fcs")))
      .toEqual({ kind: "absent", wanted: ["D1.fcs"] });
    expect(resolveFlowJoTarget({ entryId: null, names: ["D1.fcs"] }, "id0", loaded("D1.fcs")).kind).toBe("absent");
  });

  it("is absent, not apply, when nothing is loaded at all", () => {
    expect(resolveFlowJoTarget({ entryId: "id0", names: ["D1.fcs"] }, null, []).kind).toBe("absent");
  });
});

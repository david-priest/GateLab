// @vitest-environment jsdom
//
// A FlowJo workspace's strategy can only be imported onto its own sample. The import used to
// check ONLY the active sample and wait silently otherwise, so choosing several FCS at the prompt
// — where the target was not the file that happened to end up active — loaded the data with no
// gating hierarchy and gave no reason. Intermittent by nature: it depended on which file was
// active at the moment the strategy became ready.

import { describe, it, expect } from "vitest";
import { resolveFlowJoTarget } from "./flowjoWorkspace";

const loaded = (...names: string[]) => names.map((name, i) => ({ id: `id${i}`, name }));

describe("resolving which loaded sample a workspace's gates belong to", () => {
  it("applies directly when the active sample is the one the workspace gates", () => {
    const r = resolveFlowJoTarget(["19319.fcs"], "19319.fcs", loaded("19319.fcs"));
    expect(r).toEqual({ kind: "apply" });
  });

  it("switches to the target when it is loaded but not active — the reported bug", () => {
    // Three files chosen at the prompt; the workspace gates the third.
    const files = loaded("LP4 rec.fcs", "LP4 sort rec.fcs", "19319.fcs");
    const r = resolveFlowJoTarget(["19319.fcs"], "LP4 rec.fcs", files);
    expect(r).toEqual({ kind: "switch", id: "id2" });
  });

  it("reports absence rather than waiting when no loaded file matches", () => {
    const r = resolveFlowJoTarget(["19319.fcs"], "LP4 rec.fcs", loaded("LP4 rec.fcs"));
    expect(r).toEqual({ kind: "absent", wanted: ["19319.fcs"] });
  });

  it("matches on the stem, since the file on disk need not carry the recorded name", () => {
    // A workspace records the $FIL keyword; the file was renamed on export.
    expect(resolveFlowJoTarget(["19319"], "19319.FCS", loaded("19319.FCS"))).toEqual({ kind: "apply" });
    expect(resolveFlowJoTarget(["  19319.fcs  "], "19319", loaded("19319"))).toEqual({ kind: "apply" });
  });

  it("accepts any of the names a workspace records for its sample", () => {
    const files = loaded("Specimen_001_B cell presort.fcs");
    const r = resolveFlowJoTarget(["19319.fcs", "Specimen_001_B cell presort.fcs"],
                                  "Specimen_001_B cell presort.fcs", files);
    expect(r).toEqual({ kind: "apply" });
  });

  it("prefers the ACTIVE sample when it matches, over another loaded file that also would", () => {
    // Two files could satisfy the workspace; switching away from the active one would be a
    // pointless reload and would move the user's selection for no reason.
    const files = loaded("19319.fcs", "19319.FCS");
    expect(resolveFlowJoTarget(["19319"], "19319.FCS", files)).toEqual({ kind: "apply" });
  });

  it("treats an empty or blank target list as absent, never as a match", () => {
    expect(resolveFlowJoTarget([], "any.fcs", loaded("any.fcs")).kind).toBe("absent");
    expect(resolveFlowJoTarget(["", "   "], "any.fcs", loaded("any.fcs")).kind).toBe("absent");
  });

  it("is absent, not apply, when nothing is loaded at all", () => {
    expect(resolveFlowJoTarget(["19319.fcs"], "", []).kind).toBe("absent");
  });
});

import { describe, expect, it } from "vitest";
import type { FcsFile } from "./fcs";
import { Sample } from "./sample";

/** A flow file with no $SPILLOVER of its own — the FACSDiva case. */
function flowFile(opts: { spillover?: FcsFile["spillover"]; instrument?: "flow" | "cytof" } = {}): FcsFile {
  const names = ["FSC-A", "PE-A", "APC-A"];
  return {
    version: "FCS3.0",
    nEvents: 2,
    instrument: opts.instrument ?? "flow",
    keywords: { $FIL: "19319.fcs" },
    spillover: opts.spillover ?? null,
    channels: names.map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
    columns: [
      Float32Array.from([50_000, 60_000]),
      Float32Array.from([100, 400]),
      Float32Array.from([200, 800]),
    ],
  };
}

/** PE spills 0.5 into APC; nothing else. Compensated APC = APC − 0.5·PE. */
const PE_INTO_APC = { channels: ["PE-A", "APC-A"], matrix: [[1, 0.5], [0, 1]] };

describe("a spillover matrix supplied from outside the FCS", () => {
  it("compensates exactly as an embedded matrix would", () => {
    const s = new Sample(flowFile());
    expect(s.spillover).toBeNull();
    expect(s.hasCompensation).toBe(false);

    s.installExternalSpillover(PE_INTO_APC, "DivaCompMtx_19319.fcs");
    expect(s.hasCompensation).toBe(true);
    expect(s.spilloverOrigin).toEqual({
      kind: "external", label: "DivaCompMtx_19319.fcs", droppedChannels: [],
      replacedEmbedded: false, maxDeviationFromEmbedded: null,
    });

    const apc = s.index("APC-A")!;
    expect(Array.from(s.gatingColumn(apc))).toEqual([200, 800]);
    s.setCompensation(true);
    expect(s.compensationEnabled).toBe(true);
    // 200 − 0.5·100 = 150 and 800 − 0.5·400 = 600.
    expect(Array.from(s.gatingColumn(apc))).toEqual([150, 600]);

    // And scatter is untouched, as for any spillover.
    expect(Array.from(s.gatingColumn(s.index("FSC-A")!))).toEqual([50_000, 60_000]);
  });

  it("refuses to override a matrix the file already carries unless told to", () => {
    // Silently preferring an external matrix would change every gated population with nothing on
    // screen to explain it, so the caller has to say so.
    const s = new Sample(flowFile({ spillover: { channels: ["PE-A", "APC-A"], matrix: [[1, 0.1], [0, 1]] } }));
    expect(s.spillover).not.toBeNull();
    expect(() => s.installExternalSpillover(PE_INTO_APC, "workspace")).toThrow(/already carries/);
    expect(s.spilloverOrigin).toEqual({ kind: "fcs" });
  });

  it("replaces an embedded matrix on request, and records how far apart they were", () => {
    // The real case: a FACSDiva export carries the ACQUISITION matrix, while the compensation the
    // operator actually applied -- and gated under -- lives only in the FlowJo workspace. Seven
    // of forty-two coefficients differ in the published S6 workspace, by up to 0.105.
    const s = new Sample(flowFile({ spillover: { channels: ["PE-A", "APC-A"], matrix: [[1, 0.1], [0, 1]] } }));
    s.installExternalSpillover(PE_INTO_APC, "DivaCompMtx", { replaceEmbedded: true });
    expect(s.spilloverOrigin).toEqual({
      kind: "external", label: "DivaCompMtx", droppedChannels: [],
      replacedEmbedded: true, maxDeviationFromEmbedded: 0.4,
    });

    // And the values that follow are the replacement's, not the file's: 200 - 0.5*100 = 150,
    // where the embedded matrix would have given 200 - 0.1*100 = 190.
    s.setCompensation(true);
    expect(Array.from(s.gatingColumn(s.index("APC-A")!))).toEqual([150, 600]);
  });

  it("turns compensation off before swapping the matrix underneath it", () => {
    // An installed compensated layer holds values derived from the old matrix. Leaving it active
    // would keep showing them while the sample claims the new matrix.
    const s = new Sample(flowFile({ spillover: { channels: ["PE-A", "APC-A"], matrix: [[1, 0.1], [0, 1]] } }));
    s.setCompensation(true);
    expect(Array.from(s.gatingColumn(s.index("APC-A")!))).toEqual([190, 760]);
    s.installExternalSpillover(PE_INTO_APC, "DivaCompMtx", { replaceEmbedded: true });
    expect(s.compensationEnabled).toBe(false);
    s.setCompensation(true);
    expect(Array.from(s.gatingColumn(s.index("APC-A")!))).toEqual([150, 600]);
  });

  it("applies to flow data only", () => {
    const s = new Sample(flowFile({ instrument: "cytof" }));
    expect(() => s.installExternalSpillover(PE_INTO_APC, "workspace")).toThrow(/flow data only/);
  });

  it("records the parameters this file does not have", () => {
    // The matrix is reduced to the channels present, which changes the result for whatever the
    // missing ones spilled into. That is reportable, not a detail to absorb.
    const s = new Sample(flowFile());
    const wide = {
      channels: ["PE-A", "APC-A", "BV711-A"],
      matrix: [[1, 0.5, 0.2], [0, 1, 0.1], [0.3, 0.4, 1]],
    };
    const preview = s.externalSpilloverPreview(wide);
    expect(preview.dropped).toEqual(["BV711-A"]);
    expect(preview.display!.channels).toEqual(["PE-A", "APC-A"]);
    // Preview alone must not change the sample.
    expect(s.spillover).toBeNull();

    s.installExternalSpillover(wide, "workspace");
    expect(s.spilloverOrigin).toEqual({
      kind: "external", label: "workspace", droppedChannels: ["BV711-A"],
      replacedEmbedded: false, maxDeviationFromEmbedded: null,
    });
  });

  it("rejects a matrix with nothing to compensate here", () => {
    const s = new Sample(flowFile());
    expect(() =>
      s.installExternalSpillover({ channels: ["X1-A", "X2-A"], matrix: [[1, 0.5], [0, 1]] }, "workspace"),
    ).toThrow(/no usable compensation/);
    expect(s.spillover).toBeNull();
  });
});

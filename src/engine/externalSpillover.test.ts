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

describe("an FCS's own matrix that names a parameter the file lacks", () => {
  it("is cut down to the channels the file has, and says which it left out", () => {
    // flowCore and FlowKit refuse such a matrix; GateLab compensates with what it has, as it does
    // for a workspace's matrix, and records the loss instead of absorbing it.
    const s = new Sample(flowFile({
      spillover: { channels: ["FITC-A", "PE-A", "APC-A"], matrix: [[1, 0.2, 0], [0, 1, 0.5], [0, 0, 1]] },
    }));
    expect(s.spillover?.channels).toEqual(["PE-A", "APC-A"]);
    expect(s.spilloverOrigin).toEqual({ kind: "fcs", droppedChannels: ["FITC-A"] });
  });

  it("records nothing when every parameter is present", () => {
    const s = new Sample(flowFile({ spillover: PE_INTO_APC }));
    expect(s.spilloverOrigin).toEqual({ kind: "fcs" });
  });
});

// A saved workspace records the matrix as it was supplied (WorkspaceSample.externalSpillover), so a
// reopened file is compensated with it again; the parameters the file lacks stay named.
describe("the matrix as it was supplied", () => {
  it("is kept whole for the saved workspace, gives the same origin again, and goes with a restored snapshot", () => {
    const withOther = { channels: ["PE-A", "APC-A", "BV421-A"], matrix: [[1, 0.5, 0], [0, 1, 0], [0.1, 0, 1]] };
    const s = new Sample(flowFile({ spillover: { channels: ["PE-A", "APC-A"], matrix: [[1, 0.1], [0, 1]] } }));
    expect(s.externalSpillover).toBeNull();
    const before = s.spilloverSnapshot();
    s.installExternalSpillover(withOther, "Matrix_A", { replaceEmbedded: true });
    // As supplied, and the parameter this file left out named.
    expect(s.externalSpillover).toEqual({ label: "Matrix_A", ...withOther, leftOut: ["BV421-A"] });
    // Installed again from the record, on a fresh sample of the file: the same compensation and origin.
    const again = new Sample(flowFile({ spillover: { channels: ["PE-A", "APC-A"], matrix: [[1, 0.1], [0, 1]] } }));
    const { label, channels, matrix, leftOut } = s.externalSpillover!;
    again.installExternalSpillover({ channels, matrix }, label, { replaceEmbedded: true, leftOut });
    expect(again.spilloverOrigin).toEqual(s.spilloverOrigin);
    expect(again.spilloverOrigin).toMatchObject({ droppedChannels: ["BV421-A"] });
    s.setCompensation(true);
    again.setCompensation(true);
    expect(Array.from(again.gatingColumn(again.index("APC-A")!))).toEqual(Array.from(s.gatingColumn(s.index("APC-A")!)));
    // Put back to the file's own matrix, there is nothing to record.
    s.restoreSpillover(before);
    expect(s.externalSpillover).toBeNull();
  });
});

// The record names what it left out on its file, so a reopened file on which the matrix would
// leave out another parameter is refused rather than compensated otherwise without a word: a saved
// matrix naming a parameter the file lacks (a hand-edited workspace; relinking checks the file's
// identity) dropped that row and column, and the file reopened with other counts and no note.
describe("a saved matrix installed again", () => {
  const PE_APC = { channels: ["PE-A", "APC-A"], matrix: [[1, 0.5], [0, 1]] };

  it("is refused where it would leave out a parameter it compensated when it was saved", () => {
    const s = new Sample(flowFile());
    // Saved with PE-A, APC-A and BV711-A, all compensated; BV711-A renamed since.
    const renamed = { channels: ["PE-A", "APC-A", "BV711-X"], matrix: [[1, 0.5, 0.2], [0, 1, 0.1], [0.3, 0.4, 1]] };
    expect(() => s.installExternalSpillover(renamed, "Matrix_A", { leftOut: [] }))
      .toThrow(/"Matrix_A" no longer applies to this file as it did when the workspace was saved: BV711-X is not a fluorescence parameter of this file\./);
    // Nothing changed.
    expect(s.spillover).toBeNull();
    expect(s.spilloverOrigin).toEqual({ kind: "fcs" });
  });

  it("is refused where it would compensate a parameter it left out when it was saved", () => {
    const s = new Sample(flowFile());
    const wide = { channels: ["PE-A", "APC-A", "BV711-A"], matrix: [[1, 0.5, 0.2], [0, 1, 0.1], [0.3, 0.4, 1]] };
    expect(() => s.installExternalSpillover(wide, "Matrix_A", { leftOut: ["APC-A", "BV711-A"] }))
      .toThrow(/APC-A was left out then and would be compensated now\./);
    expect(s.spillover).toBeNull();
  });

  it("is installed where it leaves out exactly what it did", () => {
    const s = new Sample(flowFile());
    const wide = { channels: ["PE-A", "APC-A", "BV711-A"], matrix: [[1, 0.5, 0.2], [0, 1, 0.1], [0.3, 0.4, 1]] };
    s.installExternalSpillover(wide, "Matrix_A", { leftOut: ["BV711-A"] });
    expect(s.spilloverOrigin).toMatchObject({ kind: "external", droppedChannels: ["BV711-A"] });
    const t = new Sample(flowFile());
    t.installExternalSpillover(PE_APC, "Matrix_A", { leftOut: [] });
    expect(t.externalSpillover).toEqual({ label: "Matrix_A", ...PE_APC });
  });
});

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { flowJoWorkspaceToGatingML } from "./flowjoWorkspace";
import { importGatingML, resolveGatingMLCompensation } from "./gatingml";
import { Sample } from "./sample";
import type { FcsFile } from "./fcs";

/**
 * A FlowJo workspace whose compensation lives only in the workspace.
 *
 * Trimmed from the BD FACSDiva export behind Supplementary Figure 10A of Priest et al. 2024:
 * two fluorescence parameters instead of seven, one scatter gate and one fluorescence gate.
 * The structure is otherwise untouched — in particular the gate dimensions are named
 * `Comp-BV786-A`, and carry no `gating:compensation-ref`, exactly as FlowJo writes them.
 */
function workspace(opts: { matrix?: boolean; prefix?: string; diag?: number } = {}): string {
  const prefix = opts.prefix ?? "Comp-";
  const diag = opts.diag ?? 1;
  const matrix = opts.matrix === false ? "" : `
      <transforms:spilloverMatrix spectral="0" prefix="${prefix}" suffix="" name="DivaCompMtx_19319.fcs">
        <data-type:parameters>
          <data-type:parameter data-type:name="BV786-A" />
          <data-type:parameter data-type:name="APC-A" />
        </data-type:parameters>
        <transforms:spillover data-type:parameter="BV786-A">
          <transforms:coefficient data-type:parameter="BV786-A" transforms:value="${diag}" />
          <transforms:coefficient data-type:parameter="APC-A" transforms:value="0.25" />
        </transforms:spillover>
        <transforms:spillover data-type:parameter="APC-A">
          <transforms:coefficient data-type:parameter="BV786-A" transforms:value="0.05" />
          <transforms:coefficient data-type:parameter="APC-A" transforms:value="${diag}" />
        </transforms:spillover>
      </transforms:spilloverMatrix>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version="20.0" flowJoVersion="10.9.0"
    xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
    xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations"
    xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
  <SampleList>
    <Sample>${matrix}
      <SampleNode name="19319.fcs" count="1000">
        <Subpopulations>
          <Population name="Cells" count="800">
            <Gate>
              <gating:RectangleGate>
                <gating:dimension gating:min="10000" gating:max="200000">
                  <data-type:fcs-dimension data-type:name="FSC-A" />
                </gating:dimension>
                <gating:dimension gating:min="0" gating:max="150000">
                  <data-type:fcs-dimension data-type:name="SSC-A" />
                </gating:dimension>
              </gating:RectangleGate>
            </Gate>
            <Subpopulations>
              <Population name="CD19+" count="400">
                <Gate>
                  <gating:RectangleGate>
                    <gating:dimension gating:min="524.018" gating:max="38991.35">
                      <data-type:fcs-dimension data-type:name="${prefix}BV786-A" />
                    </gating:dimension>
                    <gating:dimension gating:min="-356.93" gating:max="3413.08">
                      <data-type:fcs-dimension data-type:name="${prefix}APC-A" />
                    </gating:dimension>
                  </gating:RectangleGate>
                </Gate>
              </Population>
            </Subpopulations>
          </Population>
        </Subpopulations>
      </SampleNode>
    </Sample>
  </SampleList>
</Workspace>`;
}

const parse = (xml: string) => new DOMParser().parseFromString(xml, "application/xml");
const GATING = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const DT = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";

/** Every gate dimension as [channel name, compensation-ref]. */
function dimensions(gatingMl: string): [string, string][] {
  const doc = parse(gatingMl);
  return Array.from(doc.getElementsByTagNameNS(DT, "fcs-dimension")).map((d) => [
    d.getAttributeNS(DT, "name") ?? "",
    d.parentElement?.getAttributeNS(GATING, "compensation-ref") ?? "",
  ]);
}

describe("FlowJo workspace compensation", () => {
  it("reads the matrix in the same orientation as an FCS $SPILLOVER", () => {
    const { spillover } = flowJoWorkspaceToGatingML(workspace(), 0);
    expect(spillover).not.toBeNull();
    expect(spillover!.name).toBe("DivaCompMtx_19319.fcs");
    expect(spillover!.prefix).toBe("Comp-");
    expect(spillover!.matrix.channels).toEqual(["BV786-A", "APC-A"]);
    // Row = source parameter, unit diagonal: BV786 spills 0.25 into APC, APC 0.05 into BV786.
    expect(spillover!.matrix.matrix).toEqual([
      [1, 0.25],
      [0.05, 1],
    ]);
  });

  it("names dimensions in uncompensated space and marks which need the matrix", () => {
    const { gatingMl } = flowJoWorkspaceToGatingML(workspace(), 0);
    // The prefix is stripped so the channel resolves to a real FCS parameter, and the reference
    // records that the gate was drawn on compensated data.
    expect(dimensions(gatingMl)).toEqual([
      ["FSC-A", "uncompensated"],
      ["SSC-A", "uncompensated"],
      ["BV786-A", "FCS"],
      ["APC-A", "FCS"],
    ]);
  });

  it("reports compensated dimensions it cannot resolve rather than importing them silently", () => {
    // Without the matrix, "Comp-BV786-A" still normalises onto the uncompensated "BV786-A", so
    // the gates would import cleanly and sit in the wrong space. This is the case that has to be
    // loud: the ordinary Gating-ML check cannot catch what was never marked as compensated.
    const { warnings, spillover, gatingMl } = flowJoWorkspaceToGatingML(
      workspace({ matrix: false }), 0);
    expect(spillover).toBeNull();
    expect(warnings.join(" ")).toMatch(/Comp-BV786-A/);
    expect(warnings.join(" ")).toMatch(/no usable compensation matrix/);
    // The requirement is still declared, so the ordinary compensation check refuses the file.
    // Calling these dimensions uncompensated would import them onto raw data instead.
    expect(dimensions(gatingMl)).toEqual([
      ["FSC-A", "uncompensated"],
      ["SSC-A", "uncompensated"],
      ["BV786-A", "FCS"],
      ["APC-A", "FCS"],
    ]);
  });

  it("uses matrix membership, not the prefix, to decide what is compensated", () => {
    // Some workspaces carry an empty prefix. Every dimension then trivially "starts with" it, so
    // only the matrix's own channel list can distinguish a compensated parameter from scatter.
    const { gatingMl, spillover } = flowJoWorkspaceToGatingML(workspace({ prefix: "" }), 0);
    expect(spillover!.prefix).toBe("");
    expect(dimensions(gatingMl)).toEqual([
      ["FSC-A", "uncompensated"],
      ["SSC-A", "uncompensated"],
      ["BV786-A", "FCS"],
      ["APC-A", "FCS"],
    ]);
  });

  it("accepts a near-unit diagonal but rejects a different matrix convention", () => {
    // Real instrument-derived diagonals are not exactly 1. The Diva matrix in the published
    // workspace runs to 1.0000020054, which an exact test rejected — and the importer then fell
    // through to a different matrix in the same file without saying so.
    const real = flowJoWorkspaceToGatingML(workspace({ diag: 1.0000020054 }), 0);
    expect(real.spillover).not.toBeNull();
    expect(real.spillover!.matrix.matrix[0][0]).toBeCloseTo(1.0000020054, 10);

    // A half-unit diagonal is a different convention, not float noise. Using it would silently
    // change every gated population, so the matrix is refused and the dimensions reported.
    const wrong = flowJoWorkspaceToGatingML(workspace({ diag: 0.5 }), 0);
    expect(wrong.spillover).toBeNull();
    expect(wrong.warnings.join(" ")).toMatch(/no usable compensation matrix/);
  });
});

/** A flow file with these four parameters and no $SPILLOVER, like a FACSDiva export. */
function divaLikeFile(): FcsFile {
  const names = ["FSC-A", "SSC-A", "BV786-A", "APC-A"];
  return {
    version: "FCS3.0",
    nEvents: 2,
    instrument: "flow",
    keywords: { $FIL: "19319.fcs" },
    spillover: null,
    channels: names.map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
    columns: [
      Float32Array.from([50_000, 60_000]),
      Float32Array.from([40_000, 45_000]),
      Float32Array.from([1000, 2000]),
      Float32Array.from([400, 800]),
    ],
  };
}

describe("importing a compensated workspace onto a file with no $SPILLOVER", () => {
  function importOnto(sample: Sample, xml: string) {
    const conv = flowJoWorkspaceToGatingML(xml, 0);
    const pnnMap: Record<string, string> = {};
    for (const c of sample.channels) pnnMap[c.pnn] = c.key;
    const res = importGatingML(conv.gatingMl, sample.channels.map((c) => c.key), pnnMap, "flow");
    const preview = conv.spillover
      ? sample.externalSpilloverPreview(conv.spillover.matrix)
      : null;
    return {
      conv,
      res,
      resolve: () =>
        resolveGatingMLCompensation(
          res.compensation,
          res.compensation_refs,
          true,
          sample.spillover ?? preview?.display ?? null,
        ),
    };
  }

  it("uses the workspace matrix and ends up genuinely compensated", () => {
    const sample = new Sample(divaLikeFile());
    const { conv, resolve } = importOnto(sample, workspace());

    // The strategy needs compensation, and the workspace matrix satisfies the requirement.
    expect(resolve().target).toBe(true);

    sample.installExternalSpillover(conv.spillover!.matrix, conv.spillover!.name);
    sample.setCompensation(true);
    expect(sample.compensationEnabled).toBe(true);

    // Compare against the matrix inverse computed here, so the expectation is derived from the
    // same matrix the workspace declared rather than being a copied-in constant.
    const [[a, b], [c, d]] = conv.spillover!.matrix.matrix;
    const det = a * d - b * c;
    const bv = sample.index("BV786-A")!;
    const apc = sample.index("APC-A")!;
    const gotBv = Array.from(sample.gatingColumn(bv));
    const gotApc = Array.from(sample.gatingColumn(apc));
    // Compared relatively: compensated columns are Float32Array, so ~7 significant digits is the
    // storage precision, and an absolute tolerance would be a test of magnitude, not of maths.
    const near = (got: number, want: number) =>
      expect(Math.abs(got - want) / Math.abs(want)).toBeLessThan(1e-6);
    for (const [i, [rawBv, rawApc]] of [[1000, 400], [2000, 800]].entries()) {
      near(gotBv[i], (rawBv * d - rawApc * c) / det);
      near(gotApc[i], (rawApc * a - rawBv * b) / det);
    }
    // Scatter is never compensated.
    expect(Array.from(sample.gatingColumn(sample.index("FSC-A")!))).toEqual([50_000, 60_000]);
  });

  it("refuses the import outright when no matrix can be found", () => {
    // This is the case that used to succeed and be wrong: "Comp-BV786-A" normalises onto the
    // uncompensated "BV786-A", so every fluorescence gate landed in the wrong space with nothing
    // reported. It must now fail, and say why.
    const sample = new Sample(divaLikeFile());
    const { resolve } = importOnto(sample, workspace({ matrix: false }));
    expect(resolve).toThrow(/no usable spillover matrix/);
  });

  it("still imports an uncompensated workspace without asking for a matrix", () => {
    // Gates on unprefixed parameters are what the FACSDiscover S8 workspace looks like. They must
    // keep importing exactly as before, and must not acquire a compensation requirement.
    const plain = workspace({ matrix: false, prefix: "" });
    const sample = new Sample(divaLikeFile());
    const { resolve } = importOnto(sample, plain);
    expect(resolve().target).toBe(false);
  });
});

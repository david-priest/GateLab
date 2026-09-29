// @vitest-environment jsdom
//
// A FlowJo workspace's spectral="1" matrix, a conventional one whose diagonal is not 1, and
// compensated dimensions no matrix can supply.
//
// FlowJo 10.6 writes the matrix its spectral compensation computed with spectral="1", and 10.10
// adds weightOptAlgorithmType="OLS". Until 2026-09-26 the converter declined every such matrix,
// and the gates drawn on it went downstream as asking for the FCS file's own compensation; on a
// file that declares none, the import evaluated them on the stored values with a note (the public
// FR-FCM-Z2JN Panel_B1.wsp: "CD21-CD23-" 1,055 events where FlowJo has 6,005). Every workspace
// and file here is synthetic; each test imports as the app and the paper's harness do
// (App.tsx prepareGatingImport, importTree): convert one tree, preview the workspace's matrix on
// the file, import with gatingMLImportOptionsFor, decide compensation with
// resolveGatingMLCompensation told whether the file declares a matrix, install, and gate.
import { describe, expect, it } from "vitest";
import { flowJoWorkspaceToGatingML } from "./flowjoWorkspace";
import {
  fcsDeclaresCompensation,
  gatingMLImportOptionsFor,
  importGatingML,
  resolveGatingMLCompensation,
} from "./gatingml";
import { applyGatingStrategy } from "./populations";
import { exportFlowJoWorkspace } from "./flowjoExport";
import { Sample } from "./sample";
import type { FcsFile, SpilloverMatrix } from "./fcs";

const NS = `xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"
    xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations"
    xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"`;

/** One `transforms:spilloverMatrix`, rows as { parameter: { column: value } }. */
function matrixXml(
  rows: Record<string, Record<string, number>>,
  opts: { spectral?: boolean; weighting?: string; name?: string; params?: string[] } = {},
): string {
  const params = opts.params ?? Object.keys(rows);
  return `<transforms:spilloverMatrix spectral="${opts.spectral === false ? 0 : 1}"${opts.weighting ? ` weightOptAlgorithmType="${opts.weighting}"` : ""} prefix="Comp-" name="${opts.name ?? "Spectral"}" suffix="">
        <data-type:parameters>${params.map((p) => `<data-type:parameter data-type:name="${p}" />`).join("")}</data-type:parameters>
        ${Object.entries(rows).map(([row, cols]) => `<transforms:spillover data-type:parameter="${row}">${
          Object.entries(cols).map(([c, v]) => `<transforms:coefficient data-type:parameter="${c}" transforms:value="${v}" />`).join("")
        }</transforms:spillover>`).join("\n        ")}
      </transforms:spilloverMatrix>`;
}

/**
 * A FlowJo 10.6.2 workspace of one sample and two trees: "Cells", a scatter rectangle with a
 * rectangle on Comp-FL1-A x Comp-FL2-A beneath it, and "Scatter", a scatter rectangle alone.
 * `own` is the sample's own matrix element, `workspace` what the Matrices block holds.
 */
function workspace(own: string, opts: { workspace?: string; bounds?: [number, number, number, number] } = {}): string {
  const [x0, x1, y0, y1] = opts.bounds ?? [-600, 800, 400, 900];
  return `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version="20.0" flowJoVersion="10.6.2" ${NS}>
  ${opts.workspace ? `<Matrices>${opts.workspace}</Matrices>` : ""}
  <SampleList>
    <Sample>${own}
      <SampleNode name="D1.fcs" count="8">
        <Subpopulations>
          <Population name="Cells" count="8">
            <Gate>
              <gating:RectangleGate>
                <gating:dimension gating:min="0" gating:max="200000"><data-type:fcs-dimension data-type:name="FSC-A" /></gating:dimension>
                <gating:dimension gating:min="0" gating:max="200000"><data-type:fcs-dimension data-type:name="SSC-A" /></gating:dimension>
              </gating:RectangleGate>
            </Gate>
            <Subpopulations>
              <Population name="Double" count="0">
                <Gate>
                  <gating:RectangleGate>
                    <gating:dimension gating:min="${x0}" gating:max="${x1}"><data-type:fcs-dimension data-type:name="Comp-FL1-A" /></gating:dimension>
                    <gating:dimension gating:min="${y0}" gating:max="${y1}"><data-type:fcs-dimension data-type:name="Comp-FL2-A" /></gating:dimension>
                  </gating:RectangleGate>
                </Gate>
              </Population>
            </Subpopulations>
          </Population>
          <Population name="Scatter" count="8">
            <Gate>
              <gating:RectangleGate>
                <gating:dimension gating:min="0" gating:max="200000"><data-type:fcs-dimension data-type:name="FSC-A" /></gating:dimension>
              </gating:RectangleGate>
            </Gate>
          </Population>
        </Subpopulations>
      </SampleNode>
    </Sample>
  </SampleList>
</Workspace>`;
}

/** Raw FL1-A and FL2-A of the synthetic file's eight events; scatter is inside "Cells" for all. */
const FL1 = [200, 500, 800, 1000, 600, 400, 900, 700];
const FL2 = [300, 600, 900, 400, 1000, 200, 800, 500];

function file(opts: { spillover?: SpilloverMatrix; extra?: string[] } = {}): FcsFile {
  const cols: Record<string, number[]> = {
    "FSC-A": FL1.map(() => 50_000), "SSC-A": FL1.map(() => 40_000), "FL1-A": FL1, "FL2-A": FL2,
  };
  for (const name of opts.extra ?? []) cols[name] = FL1.map(() => 100);
  const names = Object.keys(cols);
  const sp = opts.spillover;
  return {
    version: "FCS3.1",
    nEvents: FL1.length,
    instrument: "flow",
    keywords: sp ? { $SPILLOVER: [sp.channels.length, ...sp.channels, ...sp.matrix.flat()].join(",") } : {},
    spillover: sp ?? null,
    channels: names.map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
    columns: names.map((name) => Float32Array.from(cols[name])),
  };
}

/** The tree `tree` of sample 1 imported onto `fcs` as the app imports it; throws where the app refuses. */
function importTree(xml: string, fcs: FcsFile, tree = 0) {
  const conv = flowJoWorkspaceToGatingML(xml, 0, tree);
  const sample = new Sample(fcs);
  const pnn: Record<string, string> = {};
  for (const c of sample.channels) pnn[c.pnn] = c.key;
  const external = conv.spillover ? sample.externalSpilloverPreview(conv.spillover.matrix) : null;
  const res = importGatingML(conv.gatingMl, sample.channels.map((c) => c.key), pnn, "flow",
    gatingMLImportOptionsFor(sample, external?.display ?? null));
  const comp = resolveGatingMLCompensation(res.compensation, res.compensation_refs, true,
    external?.display ?? sample.spillover ?? null, { fcsHasSpillover: fcsDeclaresCompensation(sample.fcs) });
  if (comp.target === true && conv.spillover && external?.display != null) {
    sample.installExternalSpillover(conv.spillover.matrix, conv.spillover.name, { replaceEmbedded: sample.spillover !== null });
  }
  if (comp.target !== null) sample.setCompensation(comp.target);
  if (comp.target !== null && sample.compensationEnabled !== comp.target) throw new Error("compensation did not take effect");
  const { masks } = applyGatingStrategy(res.gates, res.populations, res.root_population_id, sample.gateAssayData());
  const members = (name: string): number[] => {
    const pop = Object.values(res.populations).find((p) => p.name === name)!;
    return Array.from(masks[pop.population_id]);
  };
  return { conv, comp, sample, res, members };
}

/** X·inv(M) for a 2 x 2 matrix over FL1-A, FL2-A, rows as written: each event's compensated pair. */
function compensated(m: [[number, number], [number, number]]): [number, number][] {
  const [[a, b], [c, d]] = m;
  const det = a * d - b * c;
  return FL1.map((x, i) => [(x * d - FL2[i] * c) / det, (FL2[i] * a - x * b) / det]);
}
const inside = (pairs: [number, number][], [x0, x1, y0, y1] = [-600, 800, 400, 900]) =>
  pairs.map(([x, y]) => (x >= x0 && x <= x1 && y >= y0 && y <= y1 ? 1 : 0));

describe("a FlowJo spectral matrix", () => {
  // FL1-A's fluorochrome spills 0.25 into FL2-A; FL2-A's peaks on FL1-A (1) and gives 0.8 on its
  // own detector, as FlowJo scales a signature to its brightest detector.
  const M: [[number, number], [number, number]] = [[1, 0.25], [1, 0.8]];
  const spectral = matrixXml({ "FL1-A": { "FL1-A": 1, "FL2-A": 0.25 }, "FL2-A": { "FL1-A": 1, "FL2-A": 0.8 } });

  it("is read as the spillover matrix FlowJo applies, X·inv(M) with the rows as written", () => {
    const { conv, comp, sample, members } = importTree(workspace(spectral), file());
    expect(conv.spillover?.name).toBe("Spectral");
    expect(conv.spillover?.matrix.matrix).toEqual(M);
    expect(comp.target).toBe(true);
    expect(sample.compensationEnabled).toBe(true);
    const want = inside(compensated(M));
    expect(members("Double")).toEqual(want);
    // The test tells the readings apart: the stored values, and the rows rescaled to a unit
    // diagonal, hold other events.
    expect(inside(FL1.map((x, i) => [x, FL2[i]]))).not.toEqual(want);
    expect(inside(compensated([[1, 0.25], [1.25, 1]]))).not.toEqual(want);
  });

  it("is read when it names its weighting OLS, as FlowJo 10.10 writes it", () => {
    const ols = matrixXml({ "FL1-A": { "FL1-A": 1, "FL2-A": 0.25 }, "FL2-A": { "FL1-A": 1, "FL2-A": 0.8 } }, { weighting: "OLS" });
    expect(importTree(workspace(ols), file()).members("Double")).toEqual(inside(compensated(M)));
  });

  it("refuses, by name, a tree drawn on one with more detectors than rows, and imports the sample's other tree", () => {
    const wide = matrixXml(
      { "FL1-A": { "FL1-A": 1, "FL2-A": 0.25, "FL3-A": 0.1 }, "FL2-A": { "FL1-A": 1, "FL2-A": 0.8, "FL3-A": 0.3 } },
      { params: ["FL1-A", "FL2-A"] },
    );
    expect(() => importTree(workspace(wide), file({ extra: ["FL3-A"] }))).toThrow(
      /"D1\.fcs": the tree "Cells" cannot be imported\. Its gates are drawn on compensated parameters \(Comp-FL1-A, Comp-FL2-A\) of the workspace's matrix "Spectral".*detectors it does not list/,
    );
    // Evaluated on the stored values it held the events there; the other tree is untouched.
    expect(importTree(workspace(wide), file({ extra: ["FL3-A"] }), 1).members("Scatter")).toEqual(FL1.map(() => 1));
  });

  it("refuses a tree drawn on one weighted otherwise", () => {
    const wls = matrixXml({ "FL1-A": { "FL1-A": 1, "FL2-A": 0.25 }, "FL2-A": { "FL1-A": 1, "FL2-A": 0.8 } }, { weighting: "WLS" });
    expect(() => importTree(workspace(wls), file())).toThrow(/tree "Cells" cannot be imported.*weighted by WLS/);
  });

  it("holds a spectral matrix to its own convention, each row's largest coefficient 1", () => {
    const percent = matrixXml({ "FL1-A": { "FL1-A": 100, "FL2-A": 25 }, "FL2-A": { "FL1-A": 100, "FL2-A": 80 } });
    expect(() => importTree(workspace(percent), file())).toThrow(/row "FL1-A" has a largest coefficient of 100, not 1/);
  });

  it("does not take another sample's matrix from the workspace when the sample's own is declined", () => {
    // The Matrices block holds one conventional matrix, which the sample would have fallen through to.
    const other = matrixXml({ "FL1-A": { "FL1-A": 1, "FL2-A": 0.1 }, "FL2-A": { "FL1-A": 0.05, "FL2-A": 1 } }, { spectral: false, name: "Other" });
    const wls = matrixXml({ "FL1-A": { "FL1-A": 1, "FL2-A": 0.25 }, "FL2-A": { "FL1-A": 1, "FL2-A": 0.8 } }, { weighting: "WLS" });
    expect(() => flowJoWorkspaceToGatingML(workspace(wls, { workspace: other }), 0, 0)).toThrow(/matrix "Spectral"/);
    // With no matrix of its own, the sample still takes the workspace's one candidate.
    expect(flowJoWorkspaceToGatingML(workspace("", { workspace: other }), 0, 0).spillover?.name).toBe("Other");
  });

  it("goes back to FlowJo as a spectral matrix, which reads back as it went out", () => {
    // Its FL2-A row peaks off the diagonal: written as a conventional matrix, the import would
    // decline its diagonal and refuse the tree.
    const { sample, res, members } = importTree(workspace(spectral), file());
    const { xml } = exportFlowJoWorkspace({
      samples: [{ sample, fileName: "D1.fcs", gates: res.gates, gate_order: res.gate_order, populations: res.populations, root_population_id: res.root_population_id }],
      now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test",
    });
    expect(xml).toMatch(/<transforms:spilloverMatrix spectral="1" prefix="Comp-"/);
    const back = importTree(xml, file());
    expect(back.conv.spillover?.matrix.matrix).toEqual(M);
    expect(back.members("Double")).toEqual(members("Double"));
    // A conventional matrix still goes out as one.
    const conventional = matrixXml({ "FL1-A": { "FL1-A": 1, "FL2-A": 0.25 }, "FL2-A": { "FL1-A": 0.05, "FL2-A": 1 } }, { spectral: false });
    const plain = importTree(workspace(conventional), file());
    const again = exportFlowJoWorkspace({
      samples: [{ sample: plain.sample, fileName: "D1.fcs", gates: plain.res.gates, gate_order: plain.res.gate_order, populations: plain.res.populations, root_population_id: plain.res.root_population_id }],
      now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test",
    });
    expect(again.xml).toMatch(/<transforms:spilloverMatrix spectral="0" prefix="Comp-"/);
  });

  it("evaluates the parameters of an identity matrix on their stored values, whatever the file carries", () => {
    // FlowJo applies the identity, so Comp-FL1-A is FL1-A. The file's own matrix is another.
    const identity = matrixXml({ "FL1-A": { "FL1-A": 1, "FL2-A": 0 }, "FL2-A": { "FL1-A": 0, "FL2-A": 1 } });
    const own: SpilloverMatrix = { channels: ["FL1-A", "FL2-A"], matrix: [[1, 0.3], [0.2, 1]] };
    const { comp, sample, members } = importTree(workspace(identity), file({ spillover: own }));
    expect(comp.target).toBe(false);
    expect(sample.compensationEnabled).toBe(false);
    const stored = inside(FL1.map((x, i) => [x, FL2[i]]));
    expect(members("Double")).toEqual(stored);
    expect(inside(compensated([[1, 0.3], [0.2, 1]]))).not.toEqual(stored);
  });
});

describe("a conventional FlowJo matrix whose diagonal is not 1", () => {
  // An Accuri C6 writes its $SPILLOVER as the inverse of the unit-diagonal compensation matrix it
  // keeps as percentages, here FL1-A less 0.2 of FL2-A and FL2-A less 0.3 of FL1-A: the diagonal
  // runs over 1 and the inverse's is 1. FlowJo applies such a matrix as written (the public
  // FR-FCM-ZYCB VALIDATION_CD25_CD127.wsp, diagonal 1.003 to 1.006, all 7 populations of its sample).
  // Until 2026-09-26 GateLab declined it and refused the tree drawn on it.
  const A: [[number, number], [number, number]] = [[1.06383, 0.212766], [0.319149, 1.06383]];
  const accuri = matrixXml(
    { "FL1-A": { "FL1-A": 1.06383, "FL2-A": 0.212766 }, "FL2-A": { "FL1-A": 0.319149, "FL2-A": 1.06383 } },
    { spectral: false, name: "Acquisition-defined" },
  );

  it("is applied as written, X·inv(M), when its inverse has a unit diagonal, as an Accuri C6 writes it", () => {
    const { conv, comp, sample, members } = importTree(workspace(accuri), file());
    expect(conv.spillover?.name).toBe("Acquisition-defined");
    expect(conv.spillover?.matrix.matrix).toEqual(A);
    expect(comp.target).toBe(true);
    expect(sample.compensationEnabled).toBe(true);
    const want = inside(compensated(A));
    expect(members("Double")).toEqual(want);
    // The test tells the readings apart: the stored values, and the rows rescaled to a unit
    // diagonal, hold other events.
    expect(inside(FL1.map((x, i) => [x, FL2[i]]))).not.toEqual(want);
    expect(inside(compensated([[1, 0.2], [0.3, 1]]))).not.toEqual(want);
    // With no matrix of its own, a sample takes it from the workspace's block as its one candidate.
    expect(flowJoWorkspaceToGatingML(workspace("", { workspace: accuri }), 0, 0).spillover?.name).toBe("Acquisition-defined");
  });

  it("goes back to FlowJo as it came, and reads back the same matrix and events", () => {
    const { sample, res, members } = importTree(workspace(accuri), file());
    const { xml } = exportFlowJoWorkspace({
      samples: [{ sample, fileName: "D1.fcs", gates: res.gates, gate_order: res.gate_order, populations: res.populations, root_population_id: res.root_population_id }],
      now: new Date("2026-09-26T00:00:00Z"), producer: "GateLab test",
    });
    expect(xml).toMatch(/<transforms:spilloverMatrix spectral="0" prefix="Comp-"/);
    const back = importTree(xml, file());
    expect(back.conv.spillover?.matrix.matrix).toEqual(A);
    expect(back.members("Double")).toEqual(members("Double"));
  });

  it("is declined, and the tree drawn on it refused by name, when its inverse's diagonal is not 1 either", () => {
    // A percentage-scaled matrix: the corpus has none, and nothing shows what FlowJo makes of one.
    const percent = matrixXml({ "FL1-A": { "FL1-A": 100, "FL2-A": 25 }, "FL2-A": { "FL1-A": 5, "FL2-A": 100 } }, { spectral: false });
    expect(() => importTree(workspace(percent), file())).toThrow(
      /the tree "Cells" cannot be imported\..*matrix "Spectral".*its diagonal is 100 at "FL1-A", not 1, nor is its inverse's \(0\.0101266 at "FL1-A"\)/,
    );
  });

  it("is declined, and the tree drawn on it refused by name, when it has no inverse", () => {
    // FlowJo writes an all-zero "Acquisition-defined" placeholder (the public FR-FCM-Z3LX).
    const zero = matrixXml({ "FL1-A": { "FL1-A": 0, "FL2-A": 0 }, "FL2-A": { "FL1-A": 0, "FL2-A": 0 } }, { spectral: false });
    expect(() => importTree(workspace(zero), file())).toThrow(
      /the tree "Cells" cannot be imported\..*its diagonal is 0 at "FL1-A", not 1, and it has no inverse, so it cannot be applied/,
    );
    // The sample's other tree, on no compensated parameter, imports.
    expect(importTree(workspace(zero), file(), 1).members("Scatter")).toEqual(FL1.map(() => 1));
  });
});

describe("compensated FlowJo dimensions no matrix covers", () => {
  it("are refused on a file that declares no compensation, never evaluated on the stored values", () => {
    // No matrix anywhere in the workspace, and none in the file: Gating-ML's "FCS" would evaluate
    // the gate uncompensated, and FlowJo's Comp-FL1-A exists only under a matrix.
    expect(() => importTree(workspace(""), file())).toThrow(
      /The gate "Double" was drawn in FlowJo on compensated values of FL1-A, FL2-A, and no spillover matrix that applies to this file covers them/,
    );
    // The same tree on a file carrying a matrix is compensated with it, as before.
    const own: SpilloverMatrix = { channels: ["FL1-A", "FL2-A"], matrix: [[1, 0.3], [0.2, 1]] };
    const { comp, members } = importTree(workspace(""), file({ spillover: own }));
    expect(comp.target).toBe(true);
    expect(members("Double")).toEqual(inside(compensated([[1, 0.3], [0.2, 1]])));
  });

  it("leave a scatter parameter a matrix lists as stored, as GateLab compensates no scatter", () => {
    // A conventional matrix listing FSC-A and SSC-A with the identity's rows and columns, as FlowJo
    // writes an acquisition's full parameter list, and the scatter gate drawn on Comp-FSC-A and
    // Comp-SSC-A: GateLab's matrix leaves out scatter, and the gate is on the stored values.
    const withScatter = matrixXml({
      "FSC-A": { "FSC-A": 1, "SSC-A": 0, "FL1-A": 0, "FL2-A": 0 },
      "SSC-A": { "FSC-A": 0, "SSC-A": 1, "FL1-A": 0, "FL2-A": 0 },
      "FL1-A": { "FSC-A": 0, "SSC-A": 0, "FL1-A": 1, "FL2-A": 0.25 },
      "FL2-A": { "FSC-A": 0, "SSC-A": 0, "FL1-A": 0.05, "FL2-A": 1 },
    }, { spectral: false });
    const xml = workspace(withScatter)
      .replace(/fcs-dimension data-type:name="FSC-A"/, 'fcs-dimension data-type:name="Comp-FSC-A"')
      .replace(/fcs-dimension data-type:name="SSC-A"/, 'fcs-dimension data-type:name="Comp-SSC-A"');
    expect(xml).toContain("Comp-FSC-A");
    const { comp, members } = importTree(xml, file());
    expect(comp.target).toBe(true);
    expect(members("Cells")).toEqual(FL1.map(() => 1));
    expect(members("Double")).toEqual(inside(compensated([[1, 0.25], [0.05, 1]])));
  });

  it("are refused where the workspace's matrix does not apply to the file and the file has none", () => {
    // The workspace's matrix is over FL1-A and FL5-A, and the file has no FL5-A: one channel of it
    // is left, which compensates nothing, and the gate is on Comp-FL1-A alone.
    const other = matrixXml({ "FL1-A": { "FL1-A": 1, "FL5-A": 0.1 }, "FL5-A": { "FL1-A": 0.05, "FL5-A": 1 } }, { spectral: false });
    const onFl1 = workspace(other).replace(
      /\s*<gating:dimension gating:min="400" gating:max="900"><data-type:fcs-dimension data-type:name="Comp-FL2-A" \/><\/gating:dimension>/, "");
    expect(onFl1).not.toContain("Comp-FL2-A");
    expect(flowJoWorkspaceToGatingML(onFl1, 0, 0).spillover?.name).toBe("Spectral");
    expect(() => importTree(onFl1, file())).toThrow(/The gate "Double" was drawn in FlowJo on compensated values of FL1-A, and no spillover matrix/);
  });
});

// @vitest-environment jsdom
//
// A FlowJo workspace imported one hierarchy per file: every tree but the primary belongs to
// another loaded file. Parsing those trees against the primary dropped any gate on a channel
// the primary lacked, and the other files were never compensated -- their hierarchies evaluated
// fluorescence gates on uncompensated values while the result line said "compensation enabled".

import { describe, it, expect } from "vitest";
import { parseFcs } from "./engine/fcs";
import { Sample } from "./engine/sample";
import { writeFcs } from "./engine/fcsExport";
import { appliedImportMatrix, resolveSiblingImport } from "./App";
import type { FcsFile } from "./engine/fcs";

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";

function sampleWith(channels: string[]): Sample {
  const n = 8;
  const cols = channels.map((_, i) => Float32Array.from({ length: n }, (__, k) => (k + 1) * (i + 1) * 100));
  const bytes = writeFcs(cols, channels.map((name) => ({ name, desc: "" })));
  return new Sample(parseFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
}

/** A one-gate Gating-ML document, as the workspace converter writes it, on the named channels. */
function gateOn(x: string, y: string): string {
  return `<gating:Gating-ML xmlns:gating="${G}" xmlns:data-type="${D}">
    <gating:RectangleGate gating:id="g1" gating:name="Bright">
      <gating:dimension gating:compensation-ref="uncompensated" gating:min="150">
        <data-type:fcs-dimension data-type:name="${x}"/></gating:dimension>
      <gating:dimension gating:compensation-ref="uncompensated" gating:min="150">
        <data-type:fcs-dimension data-type:name="${y}"/></gating:dimension>
    </gating:RectangleGate>
  </gating:Gating-ML>`;
}

describe("resolveSiblingImport", () => {
  it("parses a tree drawn on another loaded file against that file's channels", () => {
    const primary = sampleWith(["FSC-A", "SSC-A"]);
    const other = sampleWith(["FSC-A", "SSC-A", "FL3-A"]);
    const entries = [
      { id: "s1", name: "D1.fcs", sample: primary },
      { id: "s2", name: "D2.fcs", sample: other },
    ];
    const tree = { name: "D2.fcs", fileName: "D2.fcs", entryId: "s2", gatingMl: gateOn("FSC-A", "FL3-A"), spillover: null };

    const own = resolveSiblingImport(tree, primary, entries, "s1");
    // Against D2's channels the gate is read; against the primary's it was skipped.
    expect(own.sampleId).toBe("s2");
    expect(own.result.skipped_channels).toEqual([]);
    expect(own.result.n_gates_imported).toBe(1);
    expect(own.compensation).toBeDefined();
    // Uncompensated dimensions on a file without a matrix: the decision is to leave it off.
    expect(own.compensation!.target).not.toBe(true);
    expect(own.externalSpillover).toBeNull();
  });

  it("binds the tree to the loaded file it was paired with, by id, not the first file of its name", () => {
    // Two loaded files of one name, from two experiments; the open paired the tree's sample with
    // the second. Found by name, the tree went on the first.
    const primary = sampleWith(["FSC-A", "SSC-A"]);
    const first = sampleWith(["FSC-A", "SSC-A"]);
    const second = sampleWith(["FSC-A", "SSC-A", "FL3-A"]);
    const entries = [
      { id: "s1", name: "D1.fcs", sample: primary },
      { id: "s2", name: "Specimen_001_Tube_001.fcs", sample: first },
      { id: "s3", name: "Specimen_001_Tube_001.fcs", sample: second },
    ];
    const tree = { name: "Specimen_001_Tube_001.fcs", fileName: "Specimen_001_Tube_001.fcs", entryId: "s3", gatingMl: gateOn("FSC-A", "FL3-A") };
    const own = resolveSiblingImport(tree, primary, entries, "s1");
    expect(own.sampleId).toBe("s3");
    expect(own.entryId).toBe("s3");
  });

  it("falls back to the primary when the tree names no loaded file, or names the primary itself", () => {
    const primary = sampleWith(["FSC-A", "SSC-A"]);
    const entries = [{ id: "s1", name: "D1.fcs", sample: primary }];
    const absent = resolveSiblingImport(
      { name: "D9.fcs", fileName: "D9.fcs", gatingMl: gateOn("FSC-A", "SSC-A") }, primary, entries, "s1");
    expect(absent.sampleId).toBeUndefined();
    expect(absent.compensation).toBeUndefined();
    expect(absent.result.n_gates_imported).toBe(1);

    const self = resolveSiblingImport(
      { name: "second tree", gatingMl: gateOn("FSC-A", "SSC-A") }, primary, entries, "s1");
    expect(self.sampleId).toBeUndefined();
    expect(self.fileName).toBeUndefined();
  });
});

// Which gates a tree can hold depends on the matrix its file is evaluated with. The workspace's is
// installed in place of the FCS file's unless the file's is kept, so a detector only the FCS
// matrix covers is uncompensated, and a gate drawn uncompensated on it is exact (FR-FCM-Z2TQ).
describe("a sibling tree under the workspace's matrix or the file's", () => {
  const G2 = `xmlns:gating="${G}" xmlns:data-type="${D}"`;
  const rect = (id: string, x: string, xRef: string, y: string, yRef: string) => `
    <gating:RectangleGate gating:id="${id}" gating:name="${id}">
      <gating:dimension gating:compensation-ref="${xRef}" gating:min="100"><data-type:fcs-dimension data-type:name="${x}"/></gating:dimension>
      <gating:dimension gating:compensation-ref="${yRef}" gating:min="100"><data-type:fcs-dimension data-type:name="${y}"/></gating:dimension>
    </gating:RectangleGate>`;
  const gatingMl = `<gating:Gating-ML ${G2}>
    ${rect("Compensated", "BV786-A", "FCS", "APC-A", "FCS")}
    ${rect("Mixed", "BV786-A", "FCS", "AmCyan-A", "uncompensated")}
  </gating:Gating-ML>`;
  const channels = ["FSC-A", "BV786-A", "APC-A", "AmCyan-A"];
  const fcs = (): FcsFile => ({
    version: "FCS3.1", nEvents: 3, instrument: "flow", keywords: {},
    // The FCS file's own matrix covers AmCyan-A too.
    spillover: { channels: ["BV786-A", "APC-A", "AmCyan-A"], matrix: [[1, 0.2, 0.3], [0.04, 1, 0], [0.5, 0, 1]] },
    channels: channels.map((name, index) => ({ index, name, marker: null, bits: 64, range: 262144 })),
    columns: channels.map(() => Float64Array.from([500, 1000, 2000])),
  });
  const workspace = { name: "Matrix", prefix: "Comp-", suffix: "", matrix: { channels: ["BV786-A", "APC-A"], matrix: [[1, 0.25], [0.05, 1]] } };

  it("holds a gate on a detector only the FCS matrix covers when the workspace's is installed, and leaves it out, by name, when the file's is kept", () => {
    const primary = sampleWith(["FSC-A", "SSC-A"]);
    const other = new Sample(fcs());
    const entries = [
      { id: "s1", name: "D1.fcs", sample: primary },
      { id: "s2", name: "D2.fcs", sample: other },
    ];
    // The loaded file the open paired the tree with, by id (fix/multitree-import).
    const tree = { name: "D2.fcs", fileName: "D2.fcs", entryId: "s2", gatingMl, spillover: workspace };
    const names = (r: ReturnType<typeof resolveSiblingImport>) => Object.values(r.result.gates).map((g) => g.name).sort();

    const installed = resolveSiblingImport(tree, primary, entries, "s1");
    expect(installed.externalSpillover?.differsFromEmbedded).toBe(true);
    expect(names(installed)).toEqual(["Compensated", "Mixed"]);
    expect(installed.result.warnings).toEqual([]);

    const kept = resolveSiblingImport(tree, primary, entries, "s1", "file");
    expect(names(kept)).toEqual(["Compensated"]);
    expect(kept.result.warnings).toEqual([
      expect.stringMatching(/^"Mixed" declares uncompensated values on AmCyan-A, which the file's other gates compensate/),
    ]);
  });

  it("takes the workspace's matrix unless the file's differs and is kept", () => {
    const s = new Sample(fcs());
    const ws = s.externalSpilloverPreview(workspace.matrix).display!;
    expect(appliedImportMatrix(s, ws, "workspace")).toBe(ws);
    expect(appliedImportMatrix(s, ws, "file")).toBeNull();
    expect(appliedImportMatrix(s, null, "workspace")).toBeNull();
    // The same coefficients over fewer detectors: nothing to choose, and the workspace's is installed.
    const same = s.externalSpilloverPreview({ channels: ["BV786-A", "APC-A"], matrix: [[1, 0.2], [0.04, 1]] }).display!;
    expect(appliedImportMatrix(s, same, "file")).toBe(same);
  });
});

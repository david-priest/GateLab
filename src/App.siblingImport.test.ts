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
import { resolveSiblingImport } from "./App";

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
    const tree = { name: "D2.fcs", fileName: "D2.fcs", gatingMl: gateOn("FSC-A", "FL3-A"), spillover: null };

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

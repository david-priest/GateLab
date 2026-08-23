// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flowJoWorkspaceToGatingML, listFlowJoWorkspaceSamples } from "./flowjoWorkspace";
import { importGatingML, resolveGatingMLCompensation } from "./gatingml";
import { parseFcs } from "./fcs";
import { Sample, maxCoefficientDelta } from "./sample";

/**
 * The BD FACSDiva sort workspace published as Supplementary Figure 10A of Priest et al. 2024.
 *
 * Kept as a real fixture rather than an inlined trim because it is the only workspace here that
 * combines rectangles, a workspace-only compensation matrix, and FlowJo 10.9.0. Its identity was
 * established by matching all 17 gate percentages against the printed figure; the counts asserted
 * below are the ones the figure was drawn from, so a change in either direction is a regression.
 */
const wspPath =
  process.env.GATELAB_PRIEST_SORT_WSP ??
  "/Users/davidpriest/My Drive (davidpriest@cider.osaka-u.ac.jp)/Wing Lab/Large Projects/" +
    "GateLab Paper/GateLab-2026-08-15-B flowjo-and-cytobank-concordance/data/" +
    "bass12-priest2024-s6/source/flowjo-workspace/25-Sep-2023.wsp";

const fcsPath = wspPath.replace(/25-Sep-2023\.wsp$/, "Specimen_001_B cell presort.fcs");

const DT = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const GATING = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";

describe("Priest et al. 2024 published sort workspace", () => {
  const maybe = existsSync(wspPath) ? it : it.skip;

  maybe("reads the workspace-only Diva matrix for the published sample", { timeout: 60000 }, () => {
    const text = readFileSync(wspPath, "utf8");
    const samples = listFlowJoWorkspaceSamples(text);
    expect(samples).toHaveLength(1);
    expect(samples[0].name).toBe("19319.fcs");
    expect(samples[0].gateCount).toBe(18);
    expect(samples[0].unsupportedCount).toBe(0);

    const { spillover, warnings, flowJoCounts } = flowJoWorkspaceToGatingML(text, 0);

    // The FCS carries no $SPILLOVER at all; this matrix exists only inside the workspace.
    expect(spillover).not.toBeNull();
    expect(spillover!.name).toBe("DivaCompMtx_19319.fcs");
    expect(spillover!.prefix).toBe("Comp-");
    expect(spillover!.matrix.channels).toEqual([
      "PE-Cy7-A", "APC-A", "APC-Cy7-A", "BV421-A", "BV711-A", "BV786-A", "BUV805-A",
    ]);
    const m = spillover!.matrix.matrix;
    expect(m).toHaveLength(7);
    // A real Diva diagonal is near-unit, not unit: these run 0.9999999974 to 1.0000020054. The
    // parser has to accept that while still rejecting a matrix in a different convention.
    for (let i = 0; i < 7; i++) {
      expect(m[i]).toHaveLength(7);
      expect(m[i][i]).toBeCloseTo(1, 4);
      expect(m[i][i]).not.toBe(1);
    }
    // Representative coefficients, straight from the sample's own matrix.
    expect(m[0][2]).toBeCloseTo(0.0690000019, 10);
    expect(m[1][2]).toBeCloseTo(0.5132114846, 10);
    expect(m[0][0]).toBeCloseTo(0.9999999974, 10);

    // The workspace also holds an "Acquisition-defined" matrix over these same seven parameters,
    // where the corresponding coefficient is 0.0789652318 and the diagonal is exactly 1. Reading
    // the sample's own copy rather than the first one in the document is therefore load-bearing.
    expect(m[0][2]).not.toBeCloseTo(0.0789652318, 6);

    expect(warnings).toEqual([]);

    // The counts the published percentages were computed from.
    expect(flowJoCounts["IgD-"]).toBe(5805);
    expect(flowJoCounts["CD45RB+ Actmem"]).toBe(976);
    expect(flowJoCounts["CD11c- Naive"]).toBe(34983);
  });

  maybe("marks six fluorescence dimensions compensated and the four scatter ones not", { timeout: 60000 }, () => {
    const { gatingMl } = flowJoWorkspaceToGatingML(readFileSync(wspPath, "utf8"), 0);
    const doc = new DOMParser().parseFromString(gatingMl, "application/xml");
    const byRef = { FCS: new Set<string>(), uncompensated: new Set<string>() };
    for (const d of Array.from(doc.getElementsByTagNameNS(DT, "fcs-dimension"))) {
      const name = d.getAttributeNS(DT, "name") ?? "";
      const ref = d.parentElement?.getAttributeNS(GATING, "compensation-ref") ?? "";
      expect(ref === "FCS" || ref === "uncompensated").toBe(true);
      byRef[ref as "FCS" | "uncompensated"].add(name);
    }
    // Prefixes are stripped, so every name is a real FCS parameter.
    expect([...byRef.FCS].sort()).toEqual([
      "APC-A", "APC-Cy7-A", "BUV805-A", "BV711-A", "BV786-A", "PE-Cy7-A",
    ]);
    expect([...byRef.uncompensated].sort()).toEqual(["FSC-A", "FSC-W", "SSC-A", "SSC-W"]);
    expect(gatingMl).not.toMatch(/Comp-/);
  });

  // FlowJo evaluates a gate as straight lines in the space its axes are DISPLAYED in, which for
  // this workspace is biex on all six fluorescence parameters and linear on the four scatter ones.
  // Reproducing FlowJo means the fluorescence gates must import into biex space.
  //
  // The <Transformations> block is a SIBLING of <SampleNode>, not a descendant, so the first
  // version of this lookup searched a subtree that never contains it and quietly left every gate
  // in raw space. Nothing about the imported gates looked wrong — they simply carried FlowJo's
  // straight-in-raw approximation instead of its actual boundary.
  maybe("imports fluorescence gates in FlowJo's biex space and scatter gates raw", { timeout: 60000 }, () => {
    const { gatingMl } = flowJoWorkspaceToGatingML(readFileSync(wspPath, "utf8"), 0);
    const res = importGatingML(gatingMl, [
      "FSC-A", "FSC-H", "FSC-W", "SSC-A", "SSC-H", "SSC-W",
      "PE-Cy7-A", "APC-A", "APC-Cy7-A", "BV421-A", "BV711-A", "BV786-A", "BUV805-A",
    ], {}, "flow");

    const gates = Object.values(res.gates);
    expect(gates.length).toBe(18);

    const spaces = gates.map((g) => ({
      name: g.name,
      space: g.space ?? "raw",
      kinds: [g.transforms?.[g.x_channel]?.kind, g.transforms?.[g.y_channel]?.kind],
    }));
    const scatter = spaces.filter((g) => g.kinds.every((k) => k === undefined));
    const biex = spaces.filter((g) => g.kinds.some((k) => k === "biex"));

    // The three scatter gates are straight in linear, which IS raw — nothing to record.
    expect(scatter.map((g) => g.name).sort()).toEqual(["FSC A vs H", "FSC SSC", "SSc a VS h"]);
    for (const g of scatter) expect(g.space).toBe("raw");

    // Every other gate is on biex axes and must carry that space.
    expect(biex.length).toBe(15);
    for (const g of biex) {
      expect(g.space, g.name).toBe("display");
      expect(g.kinds.every((k) => k === "biex"), g.name).toBe(true);
    }

    // Nothing was reported as unrepresentable: biex is now held, not approximated.
    expect(res.untranslatable_transform_gates).toEqual([]);
  });

  // The whole chain the app runs on import, against the real file: does every gate resolve to a
  // real channel, does the workspace matrix cover them, and does the strategy end up compensated?
  (existsSync(wspPath) && existsSync(fcsPath) ? maybe : it.skip)(
    "imports end to end onto the real FCS and requires the workspace matrix",
    () => {
      const buf = readFileSync(fcsPath);
      const sample = new Sample(parseFcs(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer));

      expect(sample.instrument).toBe("flow");
      // The file DOES carry a matrix, under the non-standard "SPILL" keyword: BD FACSDiva writes
      // the acquisition matrix there. It is not the matrix these gates were drawn under.
      expect(sample.spillover).not.toBeNull();
      expect(sample.spilloverOrigin).toEqual({ kind: "fcs" });
      expect(sample.fcs.keywords["$FIL"]).toBe("19319.fcs");
      expect(sample.fcs.nEvents).toBe(74372);

      const conv = flowJoWorkspaceToGatingML(readFileSync(wspPath, "utf8"), 0);
      const pnnMap: Record<string, string> = {};
      for (const c of sample.channels) pnnMap[c.pnn] = c.key;
      const res = importGatingML(
        conv.gatingMl, sample.channels.map((c) => c.key), pnnMap, "flow");

      // Every gate arrives, and nothing was dropped for an unresolvable channel.
      expect(res.n_gates_imported).toBe(18);
      expect(res.n_gates_skipped).toBe(0);
      expect(res.skipped_channels).toEqual([]);

      // The workspace matrix covers all seven of its parameters in this file.
      const preview = sample.externalSpilloverPreview(conv.spillover!.matrix);
      expect(preview.dropped).toEqual([]);
      expect(preview.display!.channels).toHaveLength(7);

      // And the strategy declares it needs compensation, satisfied only by that matrix.
      expect(resolveGatingMLCompensation(
        res.compensation, res.compensation_refs, true, preview.display).target).toBe(true);
      expect(() => resolveGatingMLCompensation(
        res.compensation, res.compensation_refs, true, null)).toThrow(/no usable spillover matrix/);

      // The finding that matters: the file's matrix and the workspace's are NOT the same, so
      // compensating with the embedded one would move every fluorescence gate. BV711-A spills
      // 0.4046 into BV786-A at acquisition and 0.5100 in the matrix the gates were drawn under.
      const delta = maxCoefficientDelta(sample.spillover!, preview.display!);
      expect(delta).toBeGreaterThan(0.1);

      // So the workspace matrix must be installable over the embedded one, explicitly.
      expect(() => sample.installExternalSpillover(conv.spillover!.matrix, "wsp")).toThrow(
        /already carries/);
      sample.installExternalSpillover(conv.spillover!.matrix, "DivaCompMtx_19319.fcs",
        { replaceEmbedded: true });
      expect(sample.spilloverOrigin).toMatchObject({
        kind: "external", label: "DivaCompMtx_19319.fcs", replacedEmbedded: true });
      sample.setCompensation(true);
      expect(sample.compensationEnabled).toBe(true);
    });
});

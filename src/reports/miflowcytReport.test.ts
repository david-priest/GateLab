import { describe, it, expect } from "vitest";
import type { FcsFile } from "../engine/fcs";
import { Sample } from "../engine/sample";
import { applyGatingStrategy } from "../engine/populations";
import {
  newGate,
  newGateRef,
  newPopulation,
  newQuadrantGate,
  newRootPopulation,
  UNBOUNDED,
  type Gate,
  type PopulationMap,
} from "../engine/models";
import { buildMiflowcytReport, describeTransform, renderMiflowcytHtml, renderMiflowcytMarkdown, type MiflowcytFileInput } from "./miflowcytReport";

// Ten events on a grid with known positions: FSC 10..100 in steps of 10, CD4 alternating.
function synthetic(): Sample {
  const fsc = new Float32Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  const cd4 = new Float32Array([5, 500, 5, 500, 5, 500, 5, 500, 5, 500]);
  const cd8 = new Float32Array([500, 5, 5, 500, 500, 5, 5, 500, 500, 5]);
  return new Sample({
    version: "FCS3.1",
    nEvents: 10,
    instrument: "flow",
    keywords: {
      $CYT: "Synthetic cytometer",
      $FIL: "D1.fcs",
      $DATE: "01-JAN-2026",
      $P2V: "450",
      $P2L: "488",
      $P2F: "530/30",
    },
    channels: [
      { index: 0, name: "FSC-A", marker: null, bits: 32, range: 262144 },
      { index: 1, name: "FL1-A", marker: "CD4", bits: 32, range: 262144 },
      { index: 2, name: "FL2-A", marker: "CD8", bits: 32, range: 262144 },
    ],
    columns: [fsc, cd4, cd8],
    spillover: null,
  } as unknown as FcsFile);
}

function strategy(sample: Sample) {
  const fsc = sample.channels[0].key;
  const cd4 = sample.channels[1].key;
  const cd8 = sample.channels[2].key;
  // Events with FSC 30..80 inclusive: six events (30, 40, 50, 60, 70, 80).
  const cells = newGate("Cells", "rectangle", fsc, cd4, [[25, -UNBOUNDED], [85, UNBOUNDED]]);
  const quad = newQuadrantGate("CD4 CD8", cd4, cd8, [100, 100]);
  const root = newRootPopulation();
  const cellsPop = newPopulation("Cells", [newGateRef(cells.gate_id)], root.population_id);
  // Q2 = x+ y+: CD4 500 and CD8 500 among the six cells → FSC 40 and 80, two events.
  const dp = newPopulation("CD4_positive CD8_positive", [newGateRef(quad.gate_id, true, 2)], cellsPop.population_id);
  // Outside the cells gate: four events.
  const debris = newPopulation("Debris", [newGateRef(cells.gate_id, false)], root.population_id);
  root.children = [cellsPop.population_id, debris.population_id];
  cellsPop.children = [dp.population_id];
  const populations: PopulationMap = {
    [root.population_id]: root,
    [cellsPop.population_id]: cellsPop,
    [dp.population_id]: dp,
    [debris.population_id]: debris,
  };
  const gates: Record<string, Gate> = { [cells.gate_id]: cells, [quad.gate_id]: quad };
  return { gates, populations, root, cellsPop, dp, debris, cells };
}

function fileInput(): { input: MiflowcytFileInput; ids: ReturnType<typeof strategy> } {
  const sample = synthetic();
  const ids = strategy(sample);
  const { masks } = applyGatingStrategy(ids.gates, ids.populations, ids.root.population_id, sample.gateAssayData());
  const counts: Record<string, number> = {};
  for (const [id, m] of Object.entries(masks)) counts[id] = m.reduce((s, v) => s + v, 0);
  return {
    input: { fileName: "D1.fcs", sample, gates: ids.gates, populations: ids.populations, rootId: ids.root.population_id, counts },
    ids,
  };
}

describe("buildMiflowcytReport", () => {
  it("reports the counts the gates hold, with each percentage's denominator named", () => {
    const { input, ids } = fileInput();
    // The gates themselves, counted: the report must carry exactly these.
    expect(input.counts[ids.root.population_id]).toBe(10);
    expect(input.counts[ids.cellsPop.population_id]).toBe(6);
    expect(input.counts[ids.dp.population_id]).toBe(2);
    expect(input.counts[ids.debris.population_id]).toBe(4);

    const report = buildMiflowcytReport({
      files: [input],
      software: { name: "GateLab", version: "0.0.0-test" },
      generatedAt: "2026-01-01T00:00:00Z",
      minEvents: 3,
    });
    const rows = report.files[0].populations;
    expect(rows.map((r) => r.path)).toEqual([
      "All Events",
      "All Events / Cells",
      "All Events / Cells / CD4_positive CD8_positive",
      "All Events / Debris",
    ]);
    const dp = rows[2];
    expect(dp.count).toBe(2);
    expect(dp.parentPath).toBe("All Events / Cells");
    expect(dp.pctParent).toBe(33.33);
    expect(dp.pctTotal).toBe(20);
    expect(dp.belowMinEvents).toBe(true);
    expect(dp.definition).toBe("inside CD4 CD8 Q2 (x+ y+)");
    expect(rows[3].definition).toBe("outside Cells");
    expect(rows[3].pctParent).toBe(40);
    expect(rows[1].belowMinEvents).toBe(false);
  });

  it("states instrument and parameter keywords from the file, and lists what is not recorded", () => {
    const { input } = fileInput();
    const report = buildMiflowcytReport({
      files: [input],
      software: { name: "GateLab", version: "0.0.0-test", commit: "abc1234" },
      generatedAt: "2026-01-01T00:00:00Z",
      author: { purpose: "Synthetic check", organism: "Homo sapiens" },
    });
    expect(report.software).toBe("GateLab 0.0.0-test (abc1234)");
    const f = report.files[0];
    expect(f.instrument.find((i) => i.label === "Cytometer")).toEqual({ label: "Cytometer", value: "Synthetic cytometer", source: "FCS $CYT" });
    expect(f.parameters[1]).toEqual({ pnn: "FL1-A", marker: "CD4", keywords: { V: "450", L: "488", F: "530/30" } });
    expect(f.listMode.find((i) => i.label === "$FIL")?.value).toBe("D1.fcs");
    expect(report.overview.find((i) => i.label === "Purpose")?.value).toBe("Synthetic check");
    expect(report.notRecorded).toContain("Conclusions");
    expect(report.notRecorded).toContain("Cytometer serial number (D1.fcs)");
    expect(report.notRecorded).not.toContain("Organism");
    expect(f.compensation.matrix).toBeNull();
    expect(f.compensation.description).toMatch(/^No software compensation/);
  });

  it("describes each gate's boundary, edge rule and space", () => {
    const { input, ids } = fileInput();
    const report = buildMiflowcytReport({
      files: [{ ...input, tailoredGateIds: [ids.cells.gate_id] }],
      software: { name: "GateLab", version: "0.0.0-test" },
      generatedAt: "2026-01-01T00:00:00Z",
    });
    const cells = report.files[0].gates.find((g) => g.name === "Cells")!;
    expect(cells.tailored).toBe(true);
    expect(cells.description).toContain("FSC-A from 25 to 85");
    expect(cells.description).toContain("no lower bound");
    expect(cells.description).toContain("both edges included");
    expect(cells.description).toContain("raw channel values");
    const quad = report.files[0].gates.find((g) => g.name === "CD4 CD8")!;
    expect(quad.description).toContain("centred at (100, 100), straight crosshair");
  });

  it("renders Markdown holding the hierarchy table and the not-recorded list", () => {
    const { input } = fileInput();
    const md = renderMiflowcytMarkdown(buildMiflowcytReport({
      files: [input],
      software: { name: "GateLab", version: "0.0.0-test" },
      generatedAt: "2026-01-01T00:00:00Z",
    }));
    expect(md).toContain("| All Events / Cells / CD4_positive CD8_positive | inside CD4 CD8 Q2 (x+ y+) | 2 | 33.33 | All Events / Cells | 20.00 |");
    expect(md).toContain("- Purpose: Not recorded");
    expect(md).toContain("## Items not recorded");
    expect(md).toContain("| FL1-A | CD4 | $PnV 450; $PnL 488; $PnF 530/30 |");
  });
});

describe("renderMiflowcytHtml", () => {
  it("writes the same table as HTML, with the author's text escaped", () => {
    const { input } = fileInput();
    const html = renderMiflowcytHtml(buildMiflowcytReport({
      files: [input],
      software: { name: "GateLab", version: "0.0.0-test" },
      generatedAt: "2026-01-01T00:00:00Z",
      author: { purpose: "<script>alert(1)</script> & more" },
    }));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more");
    expect(html).not.toContain("<script>");
    expect(html).toContain('<td>All Events / Cells / CD4_positive CD8_positive</td><td>inside CD4 CD8 Q2 (x+ y+)</td><td class="n">2</td><td class="n">33.33</td>');
  });
});

describe("describeTransform", () => {
  it("names each transform with its parameters and Gating-ML bounds", () => {
    expect(describeTransform({ kind: "asinh", cofactor: 150 })).toBe("arcsinh(x / 150)");
    expect(describeTransform({ kind: "logicle", T: 262144, W: 0.5, M: 4.5, A: 0 })).toBe("logicle (T = 262144, W = 0.5, M = 4.5, A = 0)");
    expect(describeTransform({ kind: "identity", bounds: { min: 0, max: 1 } })).toBe("linear, boundMin 0, boundMax 1");
  });
});

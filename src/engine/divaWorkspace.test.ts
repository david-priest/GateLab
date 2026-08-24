// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isDivaWorkspace, listDivaGateTrees, divaToGatingML } from "./divaWorkspace";
import { importGatingML } from "./gatingml";
import { applyGatingStrategy } from "./populations";
import { parseFcs } from "./fcs";
import { Sample } from "./sample";

const BASE =
  "/Users/davidpriest/My Drive (davidpriest@cider.osaka-u.ac.jp)/Wing Lab/Large Projects/GateLab Paper/GateLab-2026-08-15-B flowjo-and-cytobank-concordance/data/bass12-priest2024-s6/source";
const DIVA = `${BASE}/diva-experiment/B cell assay 12.xml`;
const WSP = `${BASE}/flowjo-workspace/25-Sep-2023.wsp`;
const FCS = `${BASE}/flowjo-workspace/Specimen_001_B cell presort.fcs`;
const hasReal = existsSync(DIVA) && existsSync(WSP) && existsSync(FCS);

/** A minimal experiment in the shape Diva writes. */
function synthetic(worksheetGates: string, tubes = ""): string {
  return `<bdfacs version="Version 9.1.2"><experiment name="Synth">
    <acquisition_worksheets name="Global Worksheets">
      <worksheet_template name="Sheet1"><gates>${worksheetGates}</gates></worksheet_template>
    </acquisition_worksheets>
    <specimen name="Specimen_001">${tubes}</specimen>
  </experiment></bdfacs>`;
}
function regionGate(
  fullname: string, name: string, parent: string | null, region: string,
  opts: { logX?: boolean; logY?: boolean; scaledX?: boolean; scaledY?: boolean;
          scaleX?: number; scaleY?: number; count?: number; type?: string } = {},
): string {
  return `<gate fullname="${fullname}" type="${opts.type ?? "Region_Classifier"}">
    <name>${name}</name>${parent ? `<parent>${parent}</parent>` : ""}
    <num_events>${opts.count ?? 10}</num_events>
    <is_x_parameter_log>${opts.logX ?? false}</is_x_parameter_log>
    <is_y_parameter_log>${opts.logY ?? false}</is_y_parameter_log>
    <is_x_parameter_scaled>${opts.scaledX ?? false}</is_x_parameter_scaled>
    <is_y_parameter_scaled>${opts.scaledY ?? false}</is_y_parameter_scaled>
    <x_parameter_scale_value>${opts.scaleX ?? 0}</x_parameter_scale_value>
    <y_parameter_scale_value>${opts.scaleY ?? 0}</y_parameter_scale_value>
    ${region}
  </gate>`;
}
const poly = (xp: string, yp: string, pts: [number, number][]): string =>
  `<region name="r" xparm="${xp}" yparm="${yp}" type="POLYGON_REGION"><points>
     ${pts.map(([x, y]) => `<point x="${x}" y="${y}" />`).join("")}
   </points></region>`;
const rect = (xp: string, yp: string, pts: [number, number][]): string =>
  `<region name="r" xparm="${xp}" yparm="${yp}" type="RECTANGLE_REGION"><points>
     ${pts.map(([x, y]) => `<point x="${x}" y="${y}" />`).join("")}
   </points></region>`;
const ALL = `<gate fullname="All Events" type="EventSource_Classifier"><name>All Events</name><num_events>100</num_events></gate>`;

describe("Diva workspace import", () => {
  it("recognises a Diva export and rejects other XML", () => {
    expect(isDivaWorkspace(synthetic(ALL))).toBe(true);
    expect(isDivaWorkspace("<Workspace><SampleList/></Workspace>")).toBe(false);
    expect(isDivaWorkspace("not xml <<<")).toBe(false);
  });

  it("converts linear polygon and rectangle gates exactly, with names and hierarchy", () => {
    const xml = synthetic(
      ALL +
        regionGate("All Events\\Cells", "Cells", "All Events",
          poly("FSC-A", "SSC-A", [[1000, 2000], [50000, 2000], [50000, 90000]]), { count: 64 }) +
        regionGate("All Events\\Cells\\Singlets", "Singlets", "All Events\\Cells",
          rect("FSC-A", "FSC-H", [[100, 200], [5000, 200], [5000, 9000], [100, 9000]]), { count: 32 }),
    );
    const conv = divaToGatingML(xml, 0);
    expect(conv.warnings).toEqual([]);
    expect(conv.divaCounts).toEqual({ "All Events": 100, Cells: 64, Singlets: 32 });
    expect(conv.gatingMl).toContain('gating:name="Cells"');
    expect(conv.gatingMl).toContain('gating:name="Singlets"');
    // Linear vertices are raw and must survive byte-exact.
    expect(conv.gatingMl).toContain('data-type:value="1000"');
    expect(conv.gatingMl).toContain('gating:min="100"');
    expect(conv.gatingMl).toContain('gating:max="9000"');
    // The child parents to the polygon, and importGatingML rebuilds the chain.
    const res = importGatingML(conv.gatingMl, ["FSC-A", "SSC-A", "FSC-H"], {}, "flow");
    expect(res.n_gates_imported).toBe(2);
    const byName = Object.fromEntries(Object.values(res.gates).map((g) => [g.name, g]));
    expect(byName["Singlets"]).toBeTruthy();
  });

  it("refuses a pure-log axis by name and skips its descendants", () => {
    const xml = synthetic(
      ALL +
        regionGate("All Events\\LogGate", "LogGate", "All Events",
          poly("PE-A", "SSC-A", [[100, 0], [4000, 0], [4000, 4000]]), { logX: true }) +
        regionGate("All Events\\LogGate\\Child", "Child", "All Events\\LogGate",
          rect("FSC-A", "SSC-A", [[0, 0], [10, 0], [10, 10], [0, 10]])),
    );
    expect(() => divaToGatingML(xml, 0)).toThrow(/no gates GateLab can read/);
    // With a surviving sibling the conversion proceeds and the warning names the log gate.
    const xml2 = synthetic(
      ALL +
        regionGate("All Events\\LogGate", "LogGate", "All Events",
          poly("PE-A", "SSC-A", [[100, 0], [4000, 0], [4000, 4000]]), { logX: true }) +
        regionGate("All Events\\Fine", "Fine", "All Events",
          poly("FSC-A", "SSC-A", [[0, 0], [10, 0], [10, 10]])),
    );
    const conv = divaToGatingML(xml2, 0);
    expect(conv.gatingMl).toContain('gating:name="Fine"');
    expect(conv.gatingMl).not.toContain("LogGate");
    expect(conv.warnings.join(" ")).toMatch(/pure log display/);
    expect(conv.warnings.join(" ")).toMatch(/LogGate/);
  });

  it("skips an unknown region type together with its subtree, and says so", () => {
    const xml = synthetic(
      ALL +
        regionGate("All Events\\Oval", "Oval", "All Events",
          `<region name="r" xparm="FSC-A" yparm="SSC-A" type="OVAL_REGION"><points>
             <point x="0" y="0" /><point x="10" y="10" /><point x="0" y="10" /></points></region>`) +
        regionGate("All Events\\Oval\\Under", "Under", "All Events\\Oval",
          poly("FSC-A", "SSC-A", [[0, 0], [10, 0], [10, 10]])) +
        regionGate("All Events\\Fine", "Fine", "All Events",
          poly("FSC-A", "SSC-A", [[0, 0], [10, 0], [10, 10]])),
    );
    const conv = divaToGatingML(xml, 0);
    expect(conv.gatingMl).toContain('gating:name="Fine"');
    expect(conv.gatingMl).not.toContain("Under");
    expect(conv.warnings.join(" ")).toMatch(/OVAL_REGION/);
    expect(conv.warnings.length).toBe(1); // the child is covered by the subtree skip, not re-warned
  });

  it("lists worksheet and tube trees separately", () => {
    const xml = synthetic(
      ALL + regionGate("All Events\\A", "A", "All Events", poly("FSC-A", "SSC-A", [[0, 0], [1, 0], [1, 1]])),
      `<tube name="T1"><data_filename>t1.fcs</data_filename><gates>${ALL}${regionGate(
        "All Events\\B", "B", "All Events", poly("FSC-A", "SSC-A", [[0, 0], [1, 0], [1, 1]]))}</gates></tube>`,
    );
    const trees = listDivaGateTrees(xml);
    expect(trees.map((t) => [t.kind, t.label, t.gateCount, t.dataFilename])).toEqual([
      ["worksheet", "Sheet1", 1, null],
      ["tube", "T1", 1, "t1.fcs"],
    ]);
  });
});

// ── The real S6 pair: the calibration answer key ────────────────────────────────────────────
//
// The FlowJo workspace was created FROM this Diva experiment, so FlowJo's Diva importer has
// already converted exactly these gates to raw coordinates. That makes the pair an answer key
// for the biexponential bin conversion — and Diva's own num_events, evaluated against the very
// FCS the counts were recorded on, is the end-to-end check that does not depend on FlowJo at
// all.
describe.runIf(hasReal)("Diva import, real S6 experiment", () => {
  it("converts all 18 gates and reproduces Diva's own counts", { timeout: 120000 }, () => {
    const conv = divaToGatingML(readFileSync(DIVA, "utf-8"), 0, "Specimen_001_B cell presort.fcs");
    // The only expected warnings are the two crossed-name remaps (FSC-H and SSC-H are declared
    // widths and map to the FCS -W columns); anything else would be a silent-skip regression.
    expect(conv.warnings.length).toBe(2);
    for (const w of conv.warnings) expect(w).toMatch(/declares it as a width/);
    expect(Object.keys(conv.divaCounts).length).toBe(19); // 18 gates + All Events

    const b = readFileSync(FCS);
    const sample = new Sample(parseFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
    // Diva recorded these counts on this tube: the root count must match the file exactly, or
    // every comparison below would be against the wrong tube.
    expect(conv.divaCounts["All Events"]).toBe(sample.fcs.nEvents);

    // The gates were drawn on COMPENSATED parameters; apply the matrix the conversion carries.
    expect(conv.spillover).not.toBeNull();
    sample.installExternalSpillover(conv.spillover!.matrix, conv.spillover!.name, { replaceEmbedded: true });
    sample.setCompensation(true);

    const res = importGatingML(
      conv.gatingMl, sample.channelNames(),
      Object.fromEntries(sample.channels.map((c) => [c.pnn, c.key])), "flow");
    expect(res.n_gates_imported).toBe(18);
    const strat = applyGatingStrategy(
      res.gates, res.populations, res.root_population_id, sample.gateAssayData());

    // Diva evaluates on its own display raster, so exact agreement is not expected — the same
    // reason FlowJo's counts differ from GateLab's on this strategy. The telling cross-check:
    // this conversion agrees with FlowJo's INDEPENDENT conversion of the same gates to within a
    // few events per population (IgD- 5,818 vs FlowJo's 5,817; CD11c+CD27- both 476), and both
    // differ from Diva's own counter by the same small margins. The bounds below are what a
    // wrong axis conversion cannot satisfy — the crossed -H/-W names failed them at 90-100%,
    // and the pre-logicle biexponential model failed them at 29%.
    const counts: Record<string, number> = {};
    for (const pop of Object.values(strat.populations)) {
      counts[pop.name] = pop.event_count ?? -1;
    }
    let worst = 0;
    let worstName = "";
    const report: string[] = [];
    for (const [name, divaN] of Object.entries(conv.divaCounts)) {
      if (name === "All Events") continue;
      const ours = counts[name];
      const rel = Math.abs(ours - divaN) / Math.max(divaN, 1);
      report.push(`  ${name.padEnd(16)} diva ${String(divaN).padStart(6)}  ours ${String(ours).padStart(6)}  rel ${(100 * rel).toFixed(2)}%`);
      if (rel > worst) { worst = rel; worstName = `${name}: diva ${divaN} vs ours ${ours}`; }
    }
    console.log(report.join("\n"));
    for (const [name, divaN] of Object.entries(conv.divaCounts)) {
      if (name === "All Events") continue;
      const ours = counts[name];
      expect(ours, `population "${name}" imported`).toBeGreaterThanOrEqual(0);
      const rel = Math.abs(ours - divaN) / Math.max(divaN, 1);
      const abs = Math.abs(ours - divaN);
      // Measured on this pair: worst 3.3% relative for populations of 100+, and 5 events on a
      // 42-event population. 4%-or-8-events holds both with headroom while staying far below
      // any real conversion error.
      expect(rel <= 0.04 || abs <= 8, `"${name}": diva ${divaN}, ours ${ours}`).toBe(true);
      // The upper tree, where boundary events are a vanishing fraction, must be tight.
      if (divaN >= 5000) expect(rel, `"${name}" (large)`).toBeLessThanOrEqual(0.02);
    }
    // Record the achieved agreement so a regression is visible as a number, not a vibe.
    console.log(`worst relative count difference vs Diva: ${(100 * worst).toFixed(3)}% (${worstName})`);
  });

  it("inverting the stored compensation reproduces the hand-adjusted DivaCompMtx", () => {
    const conv = divaToGatingML(readFileSync(DIVA, "utf-8"), 0, "Specimen_001_B cell presort.fcs");
    const sp = conv.spillover!;
    const i = (ch: string) => sp.matrix.channels.indexOf(ch);
    // Reference values from the FlowJo workspace's sample-level DivaCompMtx_19319.fcs — the
    // matrix FlowJo gated with, hand-adjusted after acquisition. If inversion is right, the
    // Diva XML reproduces it, closing the provenance loop: the XML is where the matrix
    // originates.
    expect(sp.matrix.matrix[i("PE-Cy7-A")][i("APC-Cy7-A")]).toBeCloseTo(0.069, 4);
    expect(sp.matrix.matrix[i("APC-A")][i("APC-Cy7-A")]).toBeCloseTo(0.5132114846, 6);
    expect(sp.matrix.matrix[i("BV711-A")][i("BV786-A")]).toBeCloseTo(0.51, 4);
    for (let d = 0; d < sp.matrix.channels.length; d++) {
      expect(sp.matrix.matrix[d][d]).toBeCloseTo(1, 3);
    }
  });
});

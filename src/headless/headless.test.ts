// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { openFcs, importGatingOnto, memberships, populationCounts, findPopulation, packMembership } from "./headless";
import { fixtureFcs, fixtureGatingMl, fixtureEvents, fixtureExpected, FIXTURE_TIMESTEP } from "./__fixtures__/syntheticCytobank";

function gated(opts: { tailorFor?: string; file?: string } = {}) {
  const file = opts.file ?? "D1.fcs";
  const sample = openFcs(fixtureFcs(file), file);
  return importGatingOnto(sample, file, fixtureGatingMl(opts), "synthetic.xml");
}

const byPath = (rows: ReturnType<typeof populationCounts>) => Object.fromEntries(rows.map((r) => [r.path.join(" > "), r.events]));

describe("headless import of a Cytobank Gating-ML tree", () => {
  it("reads the file as Cytobank's, on a CyTOF sample, with nothing left out", () => {
    const g = gated();
    expect(g.sample.instrument).toBe("cytof");
    expect(g.source.detail).toMatch(/^Cytobank Gating-ML/);
    expect(g.refusals).toEqual([]);
    expect(Number(g.sample.fcs.keywords["$TIMESTEP"])).toBe(FIXTURE_TIMESTEP);
  });

  it("holds Time bounds in stored ticks, so the events on the Time floor are kept", () => {
    const g = gated();
    const exp = fixtureExpected();
    const masks = memberships(g);
    const time = masks[findPopulation(g.tree, "Time")];
    const floor = fixtureEvents().map((e, i) => (e.time === 1 ? i : -1)).filter((i) => i >= 0);
    expect(floor.length).toBe(exp.atFloor);
    for (const i of floor) expect(time[i]).toBe(1);
    expect(time.reduce((a, b) => a + b, 0)).toBe(exp.time);
    // A reader that took the bounds as seconds would keep only the events from 1 s on.
    expect(exp.timeScaledBySeconds).toBe(24);
    expect(byPath(populationCounts(g, masks))["Time > Cells"]).toBe(exp.cells);
  });

  it("places each barcode population under the parent its booleanExpression names", () => {
    const g = gated();
    const exp = fixtureExpected();
    const rows = populationCounts(g);
    const counts = byPath(rows);
    expect(counts["Time > Cells > B1"]).toBe(exp.B1);
    expect(counts["Time > Cells > B2"]).toBe(exp.B2);
    // The parent decides the count: without it B1 would take the DNA-negative events of its pattern.
    expect(exp.B1WithoutParent).toBeGreaterThan(exp.B1);
    const b1 = rows.find((r) => r.population === "B1")!;
    expect(b1.parentEvents).toBe(exp.cells);
    expect(b1.totalEvents).toBe(exp.total);
  });

  it("evaluates each event as the generating class says", () => {
    const g = gated();
    const masks = memberships(g);
    const b1 = masks[findPopulation(g.tree, "B1")];
    const b2 = masks[findPopulation(g.tree, "Time > Cells > B2")];
    fixtureEvents().forEach((e, i) => {
      expect(b1[i]).toBe(e.dnaPositive && e.pattern === "B1" ? 1 : 0);
      expect(b2[i]).toBe(e.dnaPositive && e.pattern === "B2" ? 1 : 0);
    });
  });

  it("puts a Cytobank gate tailored for a file onto that file only", () => {
    const exp = fixtureExpected();
    const own = gated({ tailorFor: "D2.fcs", file: "D2.fcs" });
    expect(own.notes.join(" ")).toMatch(/tailored 1 gate/);
    expect(byPath(populationCounts(own))["Time > Cells"]).toBe(0);
    const other = gated({ tailorFor: "D2.fcs", file: "D1.fcs" });
    expect(byPath(populationCounts(other))["Time > Cells"]).toBe(exp.cells);
  });
});

describe("headless refusals", () => {
  it("stops on a gate whose channel the file lacks, naming it", () => {
    const xml = fixtureGatingMl().replace(/Pd108Di/g, "Pd110Di");
    const sample = openFcs(fixtureFcs(), "D1.fcs");
    expect(() => importGatingOnto(sample, "D1.fcs", xml, "synthetic.xml")).toThrow(/Pd110Di/);
  });

  it("names a population the import leaves out instead of dropping it", () => {
    // An OR population is left out of a Gating-ML import with everything beneath it (README).
    const xml = fixtureGatingMl().replace(
      /(<gating:BooleanGate gating:id="GateSet_9">[\s\S]*?)<gating:and>([\s\S]*?)<\/gating:and>/,
      "$1<gating:or>$2</gating:or>");
    const g = importGatingOnto(openFcs(fixtureFcs(), "D1.fcs"), "D1.fcs", xml, "synthetic.xml");
    expect(g.refusals.length).toBeGreaterThan(0);
    expect(g.refusals.map((r) => r.message).join(" ")).toMatch(/B2/);
    expect(populationCounts(g).some((r) => r.population === "B2")).toBe(false);
  });

  it("refuses a selector that names no population or several", () => {
    const g = gated();
    expect(() => findPopulation(g.tree, "B3")).toThrow(/No population/);
    expect(findPopulation(g.tree, "Time > Cells > B1")).toBe(findPopulation(g.tree, "B1"));
    expect(() => findPopulation(g.tree, "Cells > B1")).toThrow(/No population/);
  });
});

describe("membership packing", () => {
  it("packs least significant bit first, as the agent MCP's reference masks do", () => {
    expect(packMembership(new Uint8Array([0, 1, 1, 0, 0, 0, 0, 0, 1]))).toBe(btoa(String.fromCharCode(6, 1)));
  });
});

// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packWorkspace, packWorkspaceReference, type WorkspaceFile } from "../engine/workspace";
import type { PopulationMap } from "../engine/models";
import { openFcs, importGatingOnto, findPopulation } from "./headless";
import { main } from "./cli";
import { fixtureFcs, fixtureGatingMl, fixtureExpected } from "./__fixtures__/syntheticCytobank";

let dir = "";
const quiet = { log: () => {}, warn: () => {} };

/**
 * A workspace of two files with a hierarchy each, as the app saves one with "One hierarchy per
 * file": D1 under the whole imported tree, D2 under a second tree holding the Time population only.
 */
function workspace(): WorkspaceFile {
  const g = importGatingOnto(openFcs(fixtureFcs("D1.fcs"), "D1.fcs"), "D1.fcs", fixtureGatingMl(), "synthetic.xml");
  const t = g.tree;
  const timeId = findPopulation(t, "Time");
  const time = t.populations[timeId];
  const root = t.populations[t.root_population_id];
  const second: PopulationMap = {
    [t.root_population_id]: { ...root, children: [timeId] },
    [timeId]: { ...time, children: [] },
  };
  const secondGates = Object.fromEntries(time.gate_refs.map((r) => [r.gate_id, t.gates[r.gate_id]]));
  return {
    format: "gatelab-workspace",
    version: 2,
    savedAt: "2026-01-01T00:00:00.000Z",
    app: "GateLab",
    samples: [
      { sampleId: "s1", fileName: "D1.fcs", dataPath: "data/0_D1.fcs", logicleW: {}, compensationOn: false, hierarchyId: "main" },
      { sampleId: "s2", fileName: "D2.fcs", dataPath: "data/1_D2.fcs", logicleW: {}, compensationOn: false, hierarchyId: "second" },
    ],
    activeSample: 0,
    gating: {
      gates: t.gates,
      gate_order: t.gate_order,
      populations: t.populations,
      root_population_id: t.root_population_id,
      active_population_id: t.root_population_id,
      selected_gate_id: null,
      hierarchies: [{ id: "main", name: "Main" }, { id: "second", name: "Second" }],
      active_hierarchy_id: "main",
      stored_hierarchies: [{
        id: "second", name: "Second", gates: secondGates, gate_order: Object.keys(secondGates),
        populations: second, root_population_id: t.root_population_id, active_population_id: t.root_population_id,
      }],
      perFileHierarchies: true,
    },
    scales: { globalScales: {} },
    display: { xChannel: "Time", yChannel: "Ir191Di", mode: "pseudocolor", maxEvents: 50000, contourThreshold: 5 },
  };
}

function counts(out: string): Record<string, string> {
  const [head, ...lines] = readFileSync(join(out, "counts.csv"), "utf8").trim().split("\n");
  const cols = head.split(",");
  const rows = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
  return Object.fromEntries(rows.map((r) => [`${r.file}|${r.hierarchy}|${r.path}`, r.events]));
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gatelab-headless-ws-"));
  writeFileSync(join(dir, "D1.fcs"), fixtureFcs("D1.fcs"));
  writeFileSync(join(dir, "D2.fcs"), fixtureFcs("D2.fcs"));
  const ws = workspace();
  writeFileSync(join(dir, "portable.gatelab"), packWorkspace(ws, { "data/0_D1.fcs": fixtureFcs("D1.fcs"), "data/1_D2.fcs": fixtureFcs("D2.fcs") }));
  writeFileSync(join(dir, "linked.gatelab"), packWorkspaceReference(ws));
});

describe("headless .gatelab workspaces", () => {
  it("gates each file of a portable workspace under the hierarchy it is assigned", async () => {
    const out = join(dir, "portable");
    expect(await main(["--gating", join(dir, "portable.gatelab"), "--out", out], quiet)).toBe(0);
    const exp = fixtureExpected();
    const c = counts(out);
    expect(c["D1.fcs|Main|Time > Cells > B1"]).toBe(String(exp.B1));
    expect(c["D1.fcs|Main|Time > Cells > B2"]).toBe(String(exp.B2));
    expect(c["D2.fcs|Second|Time"]).toBe(String(exp.time));
    expect(Object.keys(c).filter((k) => k.startsWith("D2.fcs|"))).toEqual(["D2.fcs|Second|Time"]);
  });

  it("relinks a linked workspace's FCS files by name, and counts the same", async () => {
    const out = join(dir, "linked");
    expect(await main(["--gating", join(dir, "linked.gatelab"), "--out", out, join(dir, "D2.fcs"), join(dir, "D1.fcs")], quiet)).toBe(0);
    expect(counts(out)).toEqual(counts(join(dir, "portable")));
  });

  it("refuses a linked workspace whose files are not all given, and FCS files given with a portable one", async () => {
    expect(await main(["--gating", join(dir, "linked.gatelab"), "--out", join(dir, "missing"), join(dir, "D1.fcs")], quiet)).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, "missing", "report.json"), "utf8")).error).toMatch(/D2\.fcs: not among the FCS files given/);
    expect(await main(["--gating", join(dir, "portable.gatelab"), "--out", join(dir, "extra"), join(dir, "D1.fcs")], quiet)).toBe(1);
  });
});

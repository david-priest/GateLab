// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportFlowJoWorkspace } from "../engine/flowjoExport";
import { openFcs, importGatingOnto } from "./headless";
import { main } from "./cli";
import { fixtureFcs, fixtureGatingMl, fixtureExpected } from "./__fixtures__/syntheticCytobank";

let dir = "";
const quiet = { log: () => {}, warn: () => {} };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "gatelab-headless-wsp-"));
  // A FlowJo workspace of the fixture's tree, written by GateLab's own FlowJo export.
  const g = importGatingOnto(openFcs(fixtureFcs("D1.fcs"), "D1.fcs"), "D1.fcs", fixtureGatingMl(), "synthetic.xml");
  const { xml } = exportFlowJoWorkspace({
    samples: [{ sample: g.sample, fileName: "D1.fcs", gates: g.tree.gates, gate_order: g.tree.gate_order, populations: structuredClone(g.tree.populations), root_population_id: g.tree.root_population_id }],
    now: new Date(0), producer: "GateLab headless test",
  });
  writeFileSync(join(dir, "tree.wsp"), xml);
  writeFileSync(join(dir, "D1.fcs"), fixtureFcs("D1.fcs"));
  writeFileSync(join(dir, "D3.fcs"), fixtureFcs("D3.fcs"));
});

function rows(out: string): Record<string, string>[] {
  const [head, ...lines] = readFileSync(join(out, "counts.csv"), "utf8").trim().split("\n");
  const cols = head.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
}

describe("headless FlowJo workspace import", () => {
  it("pairs the file with its workspace sample and reports FlowJo's own count beside GateLab's", async () => {
    const out = join(dir, "paired");
    expect(await main(["--gating", join(dir, "tree.wsp"), "--out", out, join(dir, "D1.fcs")], quiet)).toBe(0);
    const exp = fixtureExpected();
    const b1 = rows(out).find((r) => r.path === "Time > Cells > B1")!;
    expect(b1.events).toBe(String(exp.B1));
    expect(b1.flowjo_events).toBe(String(exp.B1));
    expect(JSON.parse(readFileSync(join(out, "report.json"), "utf8")).files[0].source.kind).toBe("flowjo");
  });

  it("refuses a file no workspace sample is, unless the sample is named", async () => {
    expect(await main(["--gating", join(dir, "tree.wsp"), "--out", join(dir, "unpaired"), join(dir, "D3.fcs")], quiet)).toBe(1);
    expect(JSON.parse(readFileSync(join(dir, "unpaired", "report.json"), "utf8")).error).toMatch(/no sample in the workspace is this file/);
    expect(await main(["--gating", join(dir, "tree.wsp"), "--out", join(dir, "named"), "--wsp-sample", "1", join(dir, "D3.fcs")], quiet)).toBe(0);
    expect(rows(join(dir, "named")).find((r) => r.path === "Time > Cells > B2")!.events).toBe(String(fixtureExpected().B2));
  });
});

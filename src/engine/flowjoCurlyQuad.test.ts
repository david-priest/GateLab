// @vitest-environment jsdom
//
// FlowJo's curly quadrant against FlowJo's own counts. The workspace declares percentX =
// percentY = 0 for every quadrant, and FlowJo still bends the arms: read as a straight
// crosshair, the eight curly-quad populations of this public workspace were out by up to 23%
// (Q1 889 against 1,151). With the bend fitted against 44 such populations
// (FLOWJO_CURLY_QUAD_CURL) every one comes within a few percent of FlowJo's count.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listFlowJoWorkspaceSamples, flowJoWorkspaceToGatingML } from "./flowjoWorkspace";
import { importGatingML, resolveGatingMLCompensation } from "./gatingml";
import { parseFcs } from "./fcs";
import { Sample } from "./sample";
import { applyGatingStrategy } from "./populations";
import type { QuadrantGate } from "./models";

// FR-FCM-Z2W3 (public, FlowRepository), as fetched by the paper's count-oracle harness.
const DIR = join(homedir(), "flowrepo_workspaces", "FR-FCM-Z2W3");
const WSP = join(DIR, "workspace_fc022-a_190923.wsp");
const FCS = join(DIR, "specimen_001_016_b05_005.fcs");

describe.runIf(existsSync(WSP) && existsSync(FCS))("FlowJo curly quadrants, FR-FCM-Z2W3", () => {
  const text = readFileSync(WSP, "utf-8");
  const stem = (s: string) => s.trim().replace(/\.fcs$/i, "").toLowerCase();
  const sampleSummary = listFlowJoWorkspaceSamples(text)
    .find((s) => s.candidateFileNames.some((n) => stem(n) === stem("specimen_001_016_b05_005.fcs")))!;
  const conv = flowJoWorkspaceToGatingML(text, sampleSummary.index, null);
  const buf = readFileSync(FCS);
  const fcs = parseFcs(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const sample = new Sample(fcs);
  const pnn: Record<string, string> = {};
  for (const c of sample.channels) pnn[c.pnn] = c.key;
  const res = importGatingML(conv.gatingMl, sample.channels.map((c) => c.key), pnn, sample.instrument);
  // Compensate as the application does on import: the workspace's matrix, which is the one the
  // gates were drawn under, over the file's own.
  const external = conv.spillover && sample.instrument === "flow"
    ? sample.externalSpilloverPreview(conv.spillover.matrix) : null;
  const comp = resolveGatingMLCompensation(res.compensation, res.compensation_refs,
    sample.instrument === "flow", external?.display ?? sample.spillover ?? null);
  if (comp.target === true && conv.spillover && external?.display != null) {
    sample.installExternalSpillover(conv.spillover.matrix, conv.spillover.name || "the FlowJo workspace",
      { replaceEmbedded: sample.spillover !== null });
  }
  if (comp.target !== null) sample.setCompensation(comp.target);
  const counts = () => {
    const { masks } = applyGatingStrategy(res.gates, res.populations, res.root_population_id, sample.gateAssayData());
    const out: Record<string, number> = {};
    for (const [pid, pop] of Object.entries(res.populations)) {
      let n = 0; for (const v of masks[pid]) n += v; out[pop.name.split("/").pop()!] = n;
    }
    return out;
  };
  /** FlowJo's recorded count for a population's parent, and the parent's own name. */
  const parentOf = (name: string): { name: string; flowjo: number } => {
    const pop = Object.values(res.populations).find((p) => p.name.endsWith(name))!;
    const parent = res.populations[pop.parent_id!];
    return { name: parent.name.split("/").pop()!, flowjo: conv.flowJoCounts[parent.name] };
  };
  const quads = Object.values(res.gates).filter((g): g is QuadrantGate => g.gate_type === "quadrant");
  const curlyNames = ["Q1: lin3- , cd32+", "Q2: lin3+ , cd32+", "Q3: lin3+ , cd32-", "Q4: lin3- , cd32-",
    "Q17: lin3- , fcrl3+", "Q18: lin3+ , fcrl3+", "Q19: lin3+ , fcrl3-", "Q20: lin3- , fcrl3-"];

  it("imports each set of four curly quads as one bent quadrant gate", () => {
    expect(quads.length).toBe(2);
    for (const q of quads) expect(q.curl).toEqual({ power: 1.5, kx: 0.012, ky: 0.012 });
    for (const name of curlyNames) {
      const pop = Object.values(res.populations).find((p) => p.name.endsWith(name));
      expect(pop, name).toBeDefined();
      expect(pop!.gate_refs[0].quadrant).toBeGreaterThanOrEqual(1);
    }
  });

  it("reproduces FlowJo's counts within a few percent, where a straight crosshair is out by up to 23%", () => {
    const bent = counts();
    let worstBent = 0;
    for (const name of curlyNames) {
      const fj = conv.flowJoCounts[name];
      expect(fj, name).toBeGreaterThan(0);
      const rel = Math.abs(bent[name] - fj) / fj;
      worstBent = Math.max(worstBent, rel);
      // The parent itself differs by about 1% between the two (FlowJo's binned evaluation), so
      // the quadrant is judged both as a count and as a fraction of its own parent.
      expect(rel, `${name}: ${bent[name]} vs FlowJo ${fj}`).toBeLessThan(0.05);
      const parent = parentOf(name);
      const fracGap = Math.abs(bent[name] / bent[parent.name] - fj / parent.flowjo);
      expect(fracGap, `${name} as a fraction of ${parent.name}`).toBeLessThan(0.007);
    }
    // The same gates straightened, for the record: the bend is what closes the gap.
    for (const q of quads) delete (res.gates[q.gate_id] as QuadrantGate).curl;
    const straight = counts();
    let worstStraight = 0;
    for (const name of curlyNames) {
      worstStraight = Math.max(worstStraight, Math.abs(straight[name] - conv.flowJoCounts[name]) / conv.flowJoCounts[name]);
    }
    expect(worstStraight).toBeGreaterThan(0.15);
    expect(worstBent).toBeLessThan(worstStraight / 4);
  });
});

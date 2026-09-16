// @vitest-environment jsdom
//
// FlowJo Boolean populations, and the per-sample tailoring they were hiding.
//
// A <NotNode> is a <Population> in every structural respect and differs only in meaning. The
// converter read only <Population>, so every Boolean node was invisible to the walk and its
// whole subtree vanished with it — silently, because the loop never saw the node to warn about
// it. On FR-FCM-Z2V4 that turned 38 gates into 4, and made every sample convert identically,
// which is what made per-sample tailored gates look impossible to import.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { listFlowJoWorkspaceSamples, flowJoWorkspaceToGatingML } from "./flowjoWorkspace";
import { importGatingML } from "./gatingml";
import { parseFcs } from "./fcs";
import { Sample } from "./sample";
import { applyGatingStrategy } from "./populations";
import { Z2V4_WORKSPACE } from "../testFixtures";

function samplesWithGates(path: string) {
  const text = readFileSync(path, "utf-8");
  return { text, samples: listFlowJoWorkspaceSamples(text).filter((s) => s.gateCount > 0) };
}

describe.runIf(existsSync(Z2V4_WORKSPACE))("FlowJo Boolean populations, FR-FCM-Z2V4", () => {
  it("imports the subtree beneath a NOT population instead of dropping it", () => {
    const { text, samples } = samplesWithGates(Z2V4_WORKSPACE);
    const result = flowJoWorkspaceToGatingML(text, samples[0].index, null);
    const gates = (result.gatingMl.match(/<gating:(Rectangle|Polygon|Ellipsoid)Gate/g) ?? []).length;

    // The whole tree, not the four nodes that sat above the first Boolean one: 36 gates, plus
    // the two NOT populations, which are derived from the populations they name rather than
    // emitted as the gate copies FlowJo stores inside them.
    expect(gates).toBe(36);
    expect(result.warnings.filter((w) => /skipped/i.test(w))).toEqual([]);
  });

  it("derives a NOT population from the population it names, and emits no BooleanGate", () => {
    const { text, samples } = samplesWithGates(Z2V4_WORKSPACE);
    const { gatingMl } = flowJoWorkspaceToGatingML(text, samples[0].index, null);

    // Not the stale copy inside the NotNode (gatelab_population_complement is that fallback).
    expect(gatingMl).toContain("gatelab_derived_populations");
    expect(gatingMl).not.toContain("gatelab_population_complement");
    // A Gating-ML BooleanGate would be more literal and is a trap: a document carrying one is
    // read as a Cytobank flat-Boolean export, where populations come from the BooleanGates
    // alone. Emitting one collapsed a 36-population tree to the two Boolean nodes.
    expect(gatingMl).not.toContain("<gating:BooleanGate");
  });

  // The copy FlowJo stores inside the NotNode is stale on this tailored workspace, and FlowJo's
  // recorded count is the complement of the population's CURRENT gate. Read from the copy,
  // "debris-" came out 6% of the file short and everything beneath it with it.
  it("reproduces FlowJo's count for the NOT population on the file beside the workspace", () => {
    const { text, samples } = samplesWithGates(Z2V4_WORKSPACE);
    const dir = dirname(Z2V4_WORKSPACE);
    const onDisk = samples
      .map((s) => ({ s, file: s.candidateFileNames.map((n) => join(dir, n)).find((p) => existsSync(p)) }))
      .filter((x): x is { s: (typeof samples)[number]; file: string } => !!x.file);
    expect(onDisk.length).toBeGreaterThan(0);
    let exact = 0;
    for (const { s, file } of onDisk) {
      const conv = flowJoWorkspaceToGatingML(text, s.index, null);
      const buf = readFileSync(file);
      const fcs = parseFcs(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
      const sample = new Sample(fcs);
      const pnn: Record<string, string> = {};
      for (const c of sample.channels) pnn[c.pnn] = c.key;
      const res = importGatingML(conv.gatingMl, sample.channels.map((c) => c.key), pnn, sample.instrument);
      const { masks } = applyGatingStrategy(res.gates, res.populations, res.root_population_id, sample.gateAssayData());
      const count = (name: string) => {
        const pid = Object.keys(res.populations).find((id) => res.populations[id].name === name)!;
        let n = 0; for (const v of masks[pid]) n += v; return n;
      };
      // The root NOT population and the population it names partition the file exactly, so
      // wherever GateLab reproduces FlowJo's count for "debris" it reproduces "debris-" too.
      // (One of the three samples differs on "debris" itself, which is a gate question, not a
      // NOT one, and is left to the count oracle.)
      expect(count("debris") + count("debris-")).toBe(fcs.nEvents);
      if (count("debris") === conv.flowJoCounts["debris"]) {
        expect(count("debris-")).toBe(conv.flowJoCounts["debris-"]);
        exact++;
      }
    }
    expect(exact).toBeGreaterThanOrEqual(2);
  });

  it("builds the whole population tree, not just the Boolean nodes", () => {
    const { text, samples } = samplesWithGates(Z2V4_WORKSPACE);
    const { gatingMl } = flowJoWorkspaceToGatingML(text, samples[0].index, null);
    const channels = [...new Set(
      [...gatingMl.matchAll(/data-type:name="([^"]+)"/g)].map((m) => m[1]))];
    const res = importGatingML(gatingMl, channels, {}, "flow");

    // One population per gate, plus the root -- not the two Boolean nodes alone.
    const names = Object.values(res.populations).map((p) => p.name);
    expect(names.length).toBeGreaterThan(30);
    for (const expected of ["debris", "Lymphocytes", "R5", "debris-"]) {
      expect(names).toContain(expected);
    }

    // And they form a TREE. Emitting a BooleanGate put every ordinary population out of reach
    // and left the two Boolean ones sitting alone under the root, which is what the reported
    // screenshot showed; most populations must therefore hang below the root, not on it.
    const root = res.populations[res.root_population_id!];
    expect(root.children.length).toBeLessThan(names.length / 2);

    // The NOT population keeps its subtree, and keeps its meaning.
    const notPop = Object.values(res.populations).find((p) => p.name === "debris-")!;
    expect(notPop.gate_refs.some((r) => r.include === false)).toBe(true);
    expect(notPop.children.length).toBeGreaterThan(0);
  });

  it("carries each sample's own coordinates, which is what per-file hierarchies hold", () => {
    // With the Boolean subtrees dropped, every sample converted to the same four gates and
    // tailoring could not be seen at all. It is the differences below them that differ.
    const { text, samples } = samplesWithGates(Z2V4_WORKSPACE);
    const outputs = new Set(
      samples.map((s) => flowJoWorkspaceToGatingML(text, s.index, null).gatingMl));
    expect(samples.length).toBeGreaterThan(1);
    expect(outputs.size).toBeGreaterThan(1);
  });

  it("round-trips through the Gating-ML importer, Boolean populations included", () => {
    const { text, samples } = samplesWithGates(Z2V4_WORKSPACE);
    const { gatingMl } = flowJoWorkspaceToGatingML(text, samples[0].index, null);
    const channels = [...new Set(
      [...gatingMl.matchAll(/data-type:name="([^"]+)"/g)].map((m) => m[1]))];

    const res = importGatingML(gatingMl, channels, {}, "flow");
    expect(res.n_gates_imported).toBeGreaterThan(30);
    // The NOT population arrives as a population holding an excluded reference, not as a gate
    // that would select the events INSIDE the boundary it was drawn from.
    const notPop = Object.values(res.populations).find((p) => p.name === "debris-");
    expect(notPop).toBeDefined();
    expect(notPop!.gate_refs.some((r) => r.include === false)).toBe(true);
  });
});

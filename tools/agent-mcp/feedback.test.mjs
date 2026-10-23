import { describe, expect, it } from "vitest";
import { contextOf, evaluateMemberships, manifestHash } from "./feedback.mjs";

const mask = (sampleId, values) => {
  const packed = Buffer.alloc(Math.ceil(values.length / 8));
  values.forEach((v, i) => { if (v) packed[i >> 3] |= 1 << (i % 8); });
  return { sampleId, eventCount: values.length, membershipBitsBase64: packed.toString("base64") };
};
export function feedbackFixture() {
  const d = {
    revision: 3, host: { app: "GateLab", version: "test", host: "browser" },
    samples: ["D1", "D2"].map((id) => ({ id, name: id, events: 5, checked: true, viewed: id === "D1", metadata: { donor: id } })),
    channels: [{ key: "X", transform: { kind: "identity" } }], rootPopulationId: "root",
    view: { populationId: "child", sampleId: "D1" },
    populations: [{ id: "root", name: "All", parentId: null }, { id: "parent", name: "Parent", parentId: "root" }, { id: "child", name: "Subset", parentId: "parent" }],
    context: { assay: { id: "exprs", space: "display" }, plot: { pooled: false, sampleIds: ["D1"] } },
  };
  const memberships = { revision: 3, populations: [
    { id: "root", sampleMasks: [mask("D1", [1,1,1,1,1]), mask("D2", [1,1,1,1,1])] },
    { id: "parent", sampleMasks: [mask("D1", [1,1,1,0,0]), mask("D2", [1,1,1,0,0])] },
    { id: "child", sampleMasks: [mask("D1", [1,0,1,0,0]), mask("D2", [1,0,1,0,0])] },
  ] };
  const reference = { format: "gatelab-reference-masks", version: 1, label: "CD4_positive", eventOrder: "as-loaded", sampleManifestSha256: manifestHash(d), sampleMasks: [mask("D1", [1,1,0,1,0]), mask("D2", [0,0,0,0,0])] };
  const args = { populationIds: ["child"], sampleIds: ["D1", "D2"], groupBy: "donor", projectedPrevalence: 0.1 };
  return { d, memberships, reference, args };
}

describe("reference feedback", () => {
  it("uses cumulative masks at natural prevalence, reports target-absent samples and ancestor losses", () => {
    const { d, memberships, reference, args } = feedbackFixture();
    const r = evaluateMemberships(d, memberships, reference, args);
    expect(r.pooled[0]).toMatchObject({ n: 10, tp: 1, fp: 3, fn: 2, tn: 4, precision: 0.25, recall: 1/3, prevalence: 0.3, falsePositiveRate: 3/7 });
    expect(r.pooled[0].f1).toBeCloseTo(2/7);
    expect(r.perSample[1]).toMatchObject({ targets: 0, fp: 2, recall: null, precision: 0, f1: 0 });
    expect(r.stages).toMatchObject([{ targetLostAtStage: 0 }, { targetLostAtStage: 1 }, { targetLostAtStage: 1, targetLostCumulative: 2 }]);
    expect(r.grouped).toHaveLength(2);
    expect(r.projected[0].precision).toBeCloseTo((1/3 * 0.1) / (1/3 * 0.1 + 3/7 * 0.9));
    expect(r.excluded).toEqual([]);
  });
  it("distinguishes checked files from actual pooling and explicitly marks unavailable context", () => {
    const { d } = feedbackFixture();
    expect(contextOf(d)).toMatchObject({ plotSelection: { pooled: false, sampleIds: ["D1"] }, checkedSampleIds: ["D1", "D2"] });
    delete d.context;
    expect(contextOf(d)).toMatchObject({ plotSelection: null, assay: null });
    expect(contextOf(d).warnings[0]).toContain("neither can be inferred");
  });
  it.each(["sampleIds", "populationIds"])("refuses empty and duplicated %s", (key) => {
    const f = feedbackFixture();
    for (const value of [[], [f.args[key][0], f.args[key][0]]]) expect(() => evaluateMemberships(f.d, f.memberships, f.reference, { ...f.args, [key]: value })).toThrow();
  });
  it("refuses stale revisions, changed assay identity and malformed reference bits", () => {
    const f = feedbackFixture();
    expect(() => evaluateMemberships(f.d, { ...f.memberships, revision: 4 }, f.reference, f.args)).toThrow(/changed/);
    f.d.context.assay.id = "counts";
    expect(() => evaluateMemberships(f.d, f.memberships, f.reference, f.args)).toThrow(/manifest/);
    f.reference.sampleManifestSha256 = manifestHash(f.d);
    f.reference.sampleMasks[0].membershipBitsBase64 = Buffer.from([255]).toString("base64");
    expect(() => evaluateMemberships(f.d, f.memberships, f.reference, f.args)).toThrow(/padding/);
  });
  it("excludes not-evaluated pairs instead of scoring empty masks as negatives", () => {
    const f = feedbackFixture();
    f.memberships.populations[1].sampleMasks[1].notEvaluated = "No matching hierarchy";
    const r = evaluateMemberships(f.d, f.memberships, f.reference, f.args);
    expect(r.pooled[0].n).toBe(5);
    expect(r.excluded).toEqual([{ populationId: "child", sampleId: "D2", reason: "No matching hierarchy" }]);
  });
  it("refuses missing samples, invalid lengths, duplicate masks and non-nested memberships", () => {
    for (const mutate of [
      (f) => { f.reference.sampleMasks.pop(); },
      (f) => { f.reference.sampleMasks[0].eventCount = 9; },
      (f) => { f.reference.sampleMasks.push(f.reference.sampleMasks[0]); },
      (f) => { f.memberships.populations[2].sampleMasks[0] = mask("D1", [1,0,1,1,0]); },
      (f) => { f.args.groupBy = "missing"; },
    ]) { const f = feedbackFixture(); mutate(f); expect(() => evaluateMemberships(f.d, f.memberships, f.reference, f.args)).toThrow(); }
  });
  it("accepts MIME/R line-wrapped base64 without changing bits", () => {
    const f = feedbackFixture();
    const before = evaluateMemberships(f.d,f.memberships,f.reference,f.args);
    for (const m of f.reference.sampleMasks) m.membershipBitsBase64 = `\n${m.membershipBitsBase64.slice(0,2)}\r\n${m.membershipBitsBase64.slice(2)}\n`;
    expect(evaluateMemberships(f.d,f.memberships,f.reference,f.args)).toEqual(before);
  });
});

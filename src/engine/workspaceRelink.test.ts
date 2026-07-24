import { describe, expect, it } from "vitest";
import { planWorkspaceFcsRelink } from "./workspaceRelink";

const candidate = (name: string, relativePath = name) => ({ name, relativePath });

describe("planWorkspaceFcsRelink", () => {
  it("matches every required FCS automatically regardless of folder enumeration order", () => {
    const requirements = [
      { dataPath: "data/0_donor-a.fcs", fileName: "donor-a.fcs" },
      { dataPath: "data/1_donor-b.fcs", fileName: "donor-b.fcs" },
    ];
    const donorA = candidate("donor-a.fcs", "batch/donor-a.fcs");
    const donorB = candidate("donor-b.fcs");
    const plan = planWorkspaceFcsRelink(requirements, [
      candidate("unrelated.fcs"),
      donorB,
      donorA,
    ]);

    expect(plan.matches.get(requirements[0].dataPath)).toBe(donorA);
    expect(plan.matches.get(requirements[1].dataPath)).toBe(donorB);
    expect(plan.missing).toEqual([]);
    expect(plan.ambiguous).toEqual([]);
  });

  it("uses a unique case-insensitive match but prefers an exact-case basename", () => {
    const requirement = { dataPath: "data/0_Donor.FCS", fileName: "Donor.FCS" };
    const insensitive = candidate("donor.fcs");
    expect(planWorkspaceFcsRelink([requirement], [insensitive]).matches.get(requirement.dataPath))
      .toBe(insensitive);

    const exact = candidate("Donor.FCS", "exact/Donor.FCS");
    const plan = planWorkspaceFcsRelink([requirement], [insensitive, exact]);
    expect(plan.matches.get(requirement.dataPath)).toBe(exact);
    expect(plan.ambiguous).toEqual([]);
  });

  it("reports missing and duplicate basenames rather than guessing", () => {
    const missing = { dataPath: "data/0_missing.fcs", fileName: "missing.fcs" };
    const ambiguous = { dataPath: "data/1_donor.fcs", fileName: "donor.fcs" };
    const plan = planWorkspaceFcsRelink(
      [missing, ambiguous],
      [
        candidate("donor.fcs", "batch-a/donor.fcs"),
        candidate("donor.fcs", "batch-b/donor.fcs"),
      ],
    );

    expect(plan.matches.size).toBe(0);
    expect(plan.missing).toEqual([missing]);
    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.ambiguous[0].candidates.map(({ relativePath }) => relativePath))
      .toEqual(["batch-a/donor.fcs", "batch-b/donor.fcs"]);
  });

  it("refuses duplicate workspace filenames that cannot be distinguished by basename", () => {
    const requirements = [
      { dataPath: "data/0_same.fcs", fileName: "same.fcs" },
      { dataPath: "data/1_same.fcs", fileName: "same.fcs" },
    ];
    const plan = planWorkspaceFcsRelink(requirements, [candidate("same.fcs")]);

    expect(plan.matches.size).toBe(0);
    expect(plan.ambiguous.map(({ requirement }) => requirement)).toEqual(requirements);
  });
});

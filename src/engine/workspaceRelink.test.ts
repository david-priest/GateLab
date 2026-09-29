import { describe, expect, it } from "vitest";
import { describeRequirement, indistinguishableDuplicateNames, planWorkspaceFcsRelink } from "./workspaceRelink";

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

  it("matches every data set of a multi-data-set file to that one file", () => {
    const requirements = [
      { dataPath: "data/0_plate.fcs", fileName: "plate (data set 1 of 2, A01).fcs" },
      { dataPath: "data/1_plate.fcs", fileName: "plate (data set 2 of 2, A02).fcs" },
      { dataPath: "data/2_donor-a.fcs", fileName: "donor-a.fcs" },
    ];
    const plate = candidate("plate.fcs", "run/plate.fcs");
    const donorA = candidate("donor-a.fcs");
    const plan = planWorkspaceFcsRelink(requirements, [donorA, plate]);
    expect(plan.matches.get("data/0_plate.fcs")).toBe(plate);
    expect(plan.matches.get("data/1_plate.fcs")).toBe(plate);
    expect(plan.matches.get("data/2_donor-a.fcs")).toBe(donorA);
    expect(plan.missing).toEqual([]);
    expect(plan.ambiguous).toEqual([]);
  });
});

describe("planWorkspaceFcsRelink and the acquisition a workspace was saved with", () => {
  const requirement = { dataPath: "data/0_Specimen_001_Tube_001.fcs", fileName: "Specimen_001_Tube_001.fcs", identity: { $TOT: "3", $BTIM: "10:00:00" } };
  const own = { $TOT: "3", $BTIM: "10:00:00" };
  const other = { $TOT: "3", $BTIM: "15:30:00" };

  it("never relinks a same-named file of another acquisition, and says what differs", () => {
    const b = candidate("Specimen_001_Tube_001.fcs", "experiment B/Specimen_001_Tube_001.fcs");
    const plan = planWorkspaceFcsRelink([requirement], [b], () => other);
    expect(plan.matches.size).toBe(0);
    expect(plan.mismatched).toHaveLength(1);
    expect(plan.mismatched[0].candidates[0].differ.map((d) => d.key)).toEqual(["$BTIM"]);
  });

  it("takes, of two files of the name, the one the keywords confirm", () => {
    const a = candidate("Specimen_001_Tube_001.fcs", "experiment A/Specimen_001_Tube_001.fcs");
    const b = candidate("Specimen_001_Tube_001.fcs", "experiment B/Specimen_001_Tube_001.fcs");
    const plan = planWorkspaceFcsRelink([requirement], [b, a], (c) => (c === a ? own : other));
    expect(plan.matches.get(requirement.dataPath)).toBe(a);
    expect(plan.ambiguous).toEqual([]);
  });

  // Two files of one name in one workspace, each saved with its own identity: the keywords tell
  // them apart, and each is relinked to its own file. They used to be refused outright.
  it("relinks two declarations of one name, each to the file its identity confirms", () => {
    const first = { dataPath: "data/0_Specimen_001_Tube_001.fcs", fileName: "Specimen_001_Tube_001.fcs", identity: own };
    const second = { dataPath: "data/1_Specimen_001_Tube_001.fcs", fileName: "Specimen_001_Tube_001.fcs", identity: other };
    expect(indistinguishableDuplicateNames([first, second])).toEqual([]);
    const a = candidate("Specimen_001_Tube_001.fcs", "experiment A/Specimen_001_Tube_001.fcs");
    const b = candidate("Specimen_001_Tube_001.fcs", "experiment B/Specimen_001_Tube_001.fcs");
    const plan = planWorkspaceFcsRelink([first, second], [b, a], (c) => (c === a ? own : other));
    expect(plan.matches.get(first.dataPath)).toBe(a);
    expect(plan.matches.get(second.dataPath)).toBe(b);
    expect(plan.ambiguous).toEqual([]);
    // With only one of them in the folder, the other is missing, not "ambiguous".
    const onlyA = planWorkspaceFcsRelink([first, second], [a], (c) => (c === a ? own : other));
    expect(onlyA.matches.get(first.dataPath)).toBe(a);
    expect(onlyA.missing).toEqual([second]);
    expect(onlyA.ambiguous).toEqual([]);
    // Without an identity on one, or with the same on both, nothing can tell them apart.
    expect(indistinguishableDuplicateNames([first, { ...second, identity: undefined }])).toEqual(["Specimen_001_Tube_001.fcs"]);
    expect(indistinguishableDuplicateNames([first, { ...second, identity: own }])).toEqual(["Specimen_001_Tube_001.fcs"]);
  });

  // The saved file sits under a lower-cased name, and another acquisition carries the exact name.
  // Only the exact-case file was considered: the folder was refused as "another acquisition", and
  // "Relink anyway" put that acquisition in the saved file's place.
  it("lets the saved identity choose among every file of the name, whatever its case", () => {
    const lower = candidate("specimen_001_tube_001.fcs", "a/specimen_001_tube_001.fcs");
    const exact = candidate("Specimen_001_Tube_001.fcs", "b/Specimen_001_Tube_001.fcs");
    const plan = planWorkspaceFcsRelink([requirement], [exact, lower], (c) => (c === lower ? own : other));
    expect(plan.matches.get(requirement.dataPath)).toBe(lower);
    expect(plan.mismatched).toEqual([]);
    expect(plan.ambiguous).toEqual([]);
    // Where the identity cannot tell them apart, the exact name still wins, as it always did.
    const unread = planWorkspaceFcsRelink([requirement], [lower, exact], () => null);
    expect(unread.matches.get(requirement.dataPath)).toBe(exact);
    // And a case-changed file whose keywords cannot be read is taken over an exact one of another acquisition.
    const lowerUnread = planWorkspaceFcsRelink([requirement], [exact, lower], (c) => (c === lower ? null : other));
    expect(lowerUnread.matches.get(requirement.dataPath)).toBe(lower);
  });

  // The saved file under a lower-cased name agrees with what it was saved with on $TOT alone, and
  // another acquisition carries the exact name. It is the right file, and it was relinked with
  // nothing said, though nothing but the elimination of the other confirms it.
  it("says a file taken over another of its name is unconfirmed where the identity does not confirm it", () => {
    const lower = candidate("specimen_001_tube_001.fcs", "a/specimen_001_tube_001.fcs");
    const exact = candidate("Specimen_001_Tube_001.fcs", "b/Specimen_001_Tube_001.fcs");
    const plan = planWorkspaceFcsRelink([requirement], [exact, lower], (c) => (c === lower ? { $TOT: "3" } : other));
    expect(plan.matches.get(requirement.dataPath)).toBe(lower);
    expect(plan.unconfirmed).toEqual([{ requirement, candidate: lower, agree: ["$TOT"], setAside: [exact] }]);
    // A file its identity confirms is not, nor the only file of its name.
    expect(planWorkspaceFcsRelink([requirement], [exact, lower], (c) => (c === lower ? own : other)).unconfirmed).toEqual([]);
    expect(planWorkspaceFcsRelink([requirement], [lower], () => ({ $TOT: "3" })).unconfirmed).toEqual([]);
  });

  // A declaration saved without identity and a case-variant of it saved with one were refused as
  // indistinguishable, and relinked in document order the first took the second's file by its exact
  // name. The identity decides for the one that has it, first; the other takes what is left.
  it("lets a declaration saved with its identity take its file before a case-variant saved without one", () => {
    const bare = { dataPath: "data/0_D1.fcs", fileName: "D1.fcs" };
    const saved = { dataPath: "data/1_d1.fcs", fileName: "d1.fcs", identity: own };
    expect(indistinguishableDuplicateNames([bare, saved])).toEqual([]);
    const exact = candidate("D1.fcs", "a/D1.fcs");
    const lower = candidate("d1.fcs", "b/d1.fcs");
    const plan = planWorkspaceFcsRelink([bare, saved], [exact, lower], (c) => (c === exact ? own : other));
    expect(plan.matches.get(saved.dataPath)).toBe(exact);
    expect(plan.matches.get(bare.dataPath)).toBe(lower);
    expect(plan.mismatched).toEqual([]);
    expect(plan.ambiguous).toEqual([]);
    // Two case-variants saved without identity, or one exact duplicate without, still cannot be told apart.
    expect(indistinguishableDuplicateNames([bare, { ...saved, identity: undefined }])).toEqual(["D1.fcs"]);
    expect(indistinguishableDuplicateNames([bare, { ...saved, fileName: "D1.fcs" }])).toEqual(["D1.fcs"]);
  });

  it("relinks by name alone a workspace saved without identity, as before", () => {
    const b = candidate("Specimen_001_Tube_001.fcs");
    const plan = planWorkspaceFcsRelink([{ dataPath: requirement.dataPath, fileName: requirement.fileName }], [b], () => other);
    expect(plan.matches.get(requirement.dataPath)).toBe(b);
  });
});

// Two declarations of one file name read identically wherever a message listed them: "x/D1.fcs as
// D1.fcs, x/D1.fcs as D1.fcs", with nothing to say which was which.
describe("describeRequirement", () => {
  const a = { dataPath: "data/0_D1.fcs", fileName: "D1.fcs", identity: { $DATE: "01-JAN-2024", $BTIM: "10:00:00" } };
  const b = { dataPath: "data/1_D1.fcs", fileName: "D1.fcs", identity: { $DATE: "02-FEB-2024", $BTIM: "15:30:00" } };
  const c = { dataPath: "data/2_D1.fcs", fileName: "d1.fcs" };
  it("is the name alone where the workspace declares it once", () => {
    expect(describeRequirement(a, [a, { dataPath: "data/3_D2.fcs", fileName: "D2.fcs" }])).toBe("D1.fcs");
  });
  it("tells declarations of one name apart by the acquisition each was saved with, or where", () => {
    expect(describeRequirement(a, [a, b, c])).toBe("D1.fcs recorded 01-JAN-2024 10:00:00");
    expect(describeRequirement(b, [a, b, c])).toBe("D1.fcs recorded 02-FEB-2024 15:30:00");
    expect(describeRequirement(c, [a, b, c])).toBe("d1.fcs saved at data/2_D1.fcs");
  });
});

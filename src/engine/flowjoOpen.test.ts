import { describe, expect, it } from "vitest";
import {
  briefReason,
  reasonWasCut,
  defaultStrategySample,
  describeUnpaired,
  distinctFileNames,
  filesToHold,
  namesInBrief,
  openTreeIndex,
  perFileImportApplies,
  perFilePrimary,
  plannedFlowJoOpen,
  tiedDataSetsNote,
  type FlowJoOpenChoice,
  type SkippedFile,
} from "./flowjoOpen";
import { pairFlowJoWorkspaceFiles, resolveFlowJoWorkspaceFiles, type FlowJoFileResolution, type FlowJoSampleSummary } from "./flowjoWorkspace";
import { translateUi } from "../ui/i18n";

const file = (name: string) => ({ name, file: new File([], name) });

describe("filesToHold", () => {
  it("skips files already loaded or already held, and holds the rest once", () => {
    const held = [file("b1.fcs")];
    const loaded = ["A1.fcs"];
    const incoming = [file("a1.fcs"), file("B1.fcs"), file("c1.fcs"), file("C1.fcs"), file("d1.fcs")];
    expect(filesToHold(held, loaded, incoming).map((f) => f.name)).toEqual(["c1.fcs", "d1.fcs"]);
  });

  it("holds everything when nothing is loaded or held", () => {
    expect(filesToHold([], [], [file("x.fcs")]).map((f) => f.name)).toEqual(["x.fcs"]);
  });

  it("counts a file as loaded when its data sets are open as samples of their own", () => {
    // Loading plate.fcs again would add every one of its data sets a second time.
    const loaded = ["plate (data set 1 of 2, A01).fcs", "plate (data set 2 of 2, A02).fcs"];
    expect(filesToHold([], loaded, [file("plate.fcs"), file("other.fcs")]).map((f) => f.name)).toEqual(["other.fcs"]);
  });
});

describe("perFilePrimary", () => {
  const sample = (index: number): FlowJoSampleSummary =>
    ({ index, name: `sample ${index}`, candidateFileNames: [`s${index}.fcs`], gateCount: 1 }) as unknown as FlowJoSampleSummary;
  const samples = [sample(0), sample(1), sample(2)];
  const resolutions: FlowJoFileResolution[] = [
    { sampleIndex: 0, fileName: null, fileKey: null, matchedName: null, status: "missing" },
    { sampleIndex: 1, fileName: "s1.fcs", fileKey: "s1.fcs", matchedName: "s1.fcs", status: "own" },
    { sampleIndex: 2, fileName: "s2.fcs", fileKey: "s2.fcs", matchedName: "s2.fcs", status: "own" },
  ];

  it("keeps the selected sample when its file was found", () => {
    expect(perFilePrimary(samples, resolutions, 2)?.index).toBe(2);
  });

  it("never substitutes another sample for the selected one", () => {
    // It used to fall back to the first found sample, overriding the row the user chose and
    // importing another sample's tree at the position chosen from the selected one's list.
    expect(perFilePrimary(samples, resolutions, 0)).toBeUndefined();
    expect(perFilePrimary(samples, resolutions, null)).toBeUndefined();
  });

  it("is undefined when no file was found at all", () => {
    const none = resolutions.map((r) => ({ ...r, fileName: null, fileKey: null, status: "missing" as const }));
    expect(perFilePrimary(samples, none, 1)).toBeUndefined();
  });
});

describe("which tree an open imports", () => {
  const sample = (index: number, trees: string[]): FlowJoSampleSummary =>
    ({
      index, name: `sample ${index}`, candidateFileNames: [`s${index}.fcs`], gateCount: trees.length,
      trees: trees.map((name, i) => ({ index: i, name, gateCount: 1, rootCount: null, unsupportedCount: 0, populations: [name] })),
    }) as unknown as FlowJoSampleSummary;
  const found = (...indices: number[]): FlowJoFileResolution[] =>
    [0, 1, 2].map((i) => indices.includes(i)
      ? { sampleIndex: i, fileName: `s${i}.fcs`, fileKey: `s${i}.fcs`, matchedName: null, status: "own" as const }
      : { sampleIndex: i, fileName: null, fileKey: null, matchedName: null, status: "missing" as const });

  it("is per file only when asked and more than one gated sample's file was found", () => {
    const gated = [sample(0, ["T"]), sample(1, ["T"])];
    expect(perFileImportApplies(true, gated, found(0, 1))).toBe(true);
    expect(perFileImportApplies(true, gated, found(0))).toBe(false);
    expect(perFileImportApplies(false, gated, found(0, 1))).toBe(false);
    // A found file belonging to an ungated sample is not a second strategy.
    expect(perFileImportApplies(true, gated.slice(0, 1), found(0, 2))).toBe(false);
  });

  it("takes the chosen tree, else the first of equal size, and never every tree at once", () => {
    const s = sample(0, ["Tree A", "Tree B", "Tree C"]);
    expect(openTreeIndex(s, { sampleIndex: 0, treeIndex: 2 }, false)).toBe(2);
    expect(openTreeIndex(s, null, false)).toBe(0);
    expect(openTreeIndex(s, { sampleIndex: 0, treeIndex: 7 }, false)).toBe(0);
    // Per file, each file's trees go in together, as one tree.
    expect(openTreeIndex(s, { sampleIndex: 0, treeIndex: 2 }, true)).toBeNull();
  });

  it("defaults to the readable tree with the most gates, the first of those tied", () => {
    // A small tree of bead gates written before the analysis (FR-FCM-Z6L9: "beads", 2 gates, and
    // "Lymphocytes", 23) was the default, and imported unless the user found the choice.
    const s = sample(0, ["beads", "Lymphocytes", "Other"]);
    [2, 23, 23].forEach((n, i) => { s.trees[i].gateCount = n; });
    expect(openTreeIndex(s, null, false)).toBe(1);
    expect(openTreeIndex(s, { sampleIndex: 0, treeIndex: 0 }, false)).toBe(0);
    expect(openTreeIndex(s, { sampleIndex: 1, treeIndex: 0 }, false)).toBe(1);
  });

  it("never defaults to, nor takes, a tree with no gate the importer can read", () => {
    const s = sample(0, ["Unreadable", "Tree B"]);
    s.trees[0].gateCount = 0;
    expect(openTreeIndex(s, null, false)).toBe(1);
    expect(openTreeIndex(s, { sampleIndex: 0, treeIndex: 0 }, false)).toBe(1);
    // With nothing readable, the first is still named, and fails with its reason.
    s.trees[1].gateCount = 0;
    expect(openTreeIndex(s, null, false)).toBe(0);
  });

  it("never applies a tree position chosen on one sample to another sample's trees", () => {
    // The defect: "D1_beads", second of sample 0's trees, was chosen, and sample 1's second tree
    // was imported.
    const other = sample(1, ["D2_lymphocytes", "D2_monocytes"]);
    expect(openTreeIndex(other, { sampleIndex: 0, treeIndex: 1 }, false)).toBe(0);
  });
});

describe("namesInBrief", () => {
  it("names every one when there are few", () => {
    expect(namesInBrief(["A", "B"])).toBe('"A", "B"');
    expect(namesInBrief(["A", "B", "C", "D", "E", "F"])).toBe('"A", "B", "C", "D", "E", "F"');
  });

  it("names the first few of many and counts the rest", () => {
    const names = Array.from({ length: 70 }, (_, i) => `Tree_${i + 1}`);
    expect(namesInBrief(names)).toBe('"Tree_1", "Tree_2", "Tree_3", "Tree_4", "Tree_5" and 65 more');
  });

  it("shortens a long name", () => {
    expect(namesInBrief(["x".repeat(60)], 6, 10)).toBe(`"${"x".repeat(9)}…"`);
  });
});

describe("the open plan: the sample listed is the sample imported", () => {
  const tree = (index: number, name: string) => ({ index, name, gateCount: 1, rootCount: null, unsupportedCount: 0, populations: [name] });
  const summary = (index: number, name: string, trees: string[], recorded = {}): FlowJoSampleSummary => ({
    index, name, owningGroup: "", duplicateName: false, rootCount: trees.length, candidateFileNames: [name],
    trees: trees.map((t, i) => tree(i, t)), eventCount: 3, gateCount: trees.length + (index === 0 ? 5 : 0), unsupportedCount: 0, recorded,
  });
  // D1 carries the most gates, the old default; only D2's file is supplied.
  const D1 = summary(0, "D1.fcs", ["D1_lymphocytes", "D1_beads"]);
  const D2 = summary(1, "D2.fcs", ["D2_lymphocytes", "D2_monocytes"]);
  const files = [{ key: "pending:0", name: "D2.fcs", keywords: null }];
  const choice = (over: Partial<FlowJoOpenChoice> = {}): FlowJoOpenChoice => ({
    samples: [D1, D2], strategySample: null, strategyTouched: false, strategyTree: null, perFileTrees: true, crossFile: null, ...over,
  });
  const resolutions = () => resolveFlowJoWorkspaceFiles([D1, D2], files);

  it("selects the sample the supplied file is, and lists and imports that sample's trees", () => {
    const plan = plannedFlowJoOpen(choice(), resolutions(), files, ["pending:0"]);
    expect(plan.sample?.name).toBe("D2.fcs");
    expect(plan.target).toEqual({ fileKey: "pending:0", fileName: "D2.fcs", cross: false });
    expect(plan.perFile).toBe(false);
    const picked = plannedFlowJoOpen(choice({ strategyTree: { sampleIndex: 1, treeIndex: 1 } }), resolutions(), files, ["pending:0"]);
    expect(plan.sample!.trees.find((t) => t.index === picked.treeIndex)?.name).toBe("D2_monocytes");
  });

  it("imports nothing for a sample chosen by hand whose file is missing, unless a file is chosen for it", () => {
    // The defect: the radio on D1, the user chose "D1_beads", and D2's second tree was imported.
    const byHand = choice({ strategySample: 0, strategyTouched: true, strategyTree: { sampleIndex: 0, treeIndex: 1 } });
    const plan = plannedFlowJoOpen(byHand, resolutions(), files, ["pending:0"]);
    expect(plan.sample?.name).toBe("D1.fcs");
    expect(plan.target).toBeNull();
    // Chosen explicitly, D1's tree goes onto D2.fcs, marked as another sample's.
    const crossed = plannedFlowJoOpen({ ...byHand, crossFile: { sampleIndex: 0, fileKey: "pending:0" } }, resolutions(), files, ["pending:0"]);
    expect(crossed.target).toEqual({ fileKey: "pending:0", fileName: "D2.fcs", cross: true });
    expect(D1.trees.find((t) => t.index === crossed.treeIndex)?.name).toBe("D1_beads");
  });

  it("selects nothing when no file is any sample's, rather than the sample with most gates", () => {
    expect(defaultStrategySample([D1, D2], resolveFlowJoWorkspaceFiles([D1, D2], []), [])).toBeNull();
    expect(defaultStrategySample([D2], resolveFlowJoWorkspaceFiles([D2], []), [])).toBe(1);
  });

  it("gives each copy of a sample's file that sample's tree under a per-file import", () => {
    // D1.fcs and D1 copy.fcs record one acquisition; D2.fcs is the primary. Both D1 files are D1.
    const kw1 = { $BTIM: "10:00:00", $ETIM: "10:01:00" };
    const d1 = { ...D1, candidateFileNames: ["D1.fcs"], recorded: kw1 };
    const d2 = { ...D2, recorded: { $BTIM: "15:30:00" } };
    const three = [
      { key: "pending:0", name: "D2.fcs", keywords: { $BTIM: "15:30:00" } },
      { key: "pending:1", name: "D1.fcs", keywords: kw1 },
      { key: "pending:2", name: "D1 copy.fcs", keywords: { ...kw1, $FIL: "D1.fcs" } },
    ];
    const plan = plannedFlowJoOpen({ ...choice(), samples: [d1, d2] }, resolveFlowJoWorkspaceFiles([d1, d2], three), three, ["pending:0"]);
    expect(plan.pairs.map((p) => `${p.sample.name}<-${p.fileName}`)).toEqual(["D2.fcs<-D2.fcs", "D1.fcs<-D1.fcs", "D1.fcs<-D1 copy.fcs"]);
    // With D1 the primary, its copy gets its tree as its own, first after it.
    const own = plannedFlowJoOpen({ ...choice(), samples: [d1, d2] }, resolveFlowJoWorkspaceFiles([d1, d2], three), three, ["pending:1"]);
    expect(own.pairs.map((p) => `${p.sample.name}<-${p.fileName}`)).toEqual(["D1.fcs<-D1.fcs", "D1.fcs<-D1 copy.fcs", "D2.fcs<-D2.fcs"]);
  });

  it("pairs every file with its own sample under a per-file import, the chosen one first", () => {
    const both = [...files, { key: "pending:1", name: "D1.fcs", keywords: null }];
    const plan = plannedFlowJoOpen(choice(), resolveFlowJoWorkspaceFiles([D1, D2], both), both, ["pending:0", "pending:1"]);
    expect(plan.perFile).toBe(true);
    expect(plan.pairs.map((p) => `${p.sample.name}<-${p.fileName}`)).toEqual(["D2.fcs<-D2.fcs", "D1.fcs<-D1.fcs"]);
  });
});

describe("briefReason", () => {
  it("keeps a short reason whole, and cuts a long one at a list separator", () => {
    expect(briefReason("it names no operand.")).toBe("it names no operand.");
    const long = `gates on channels the file lacks: ${Array.from({ length: 80 }, (_, i) => `"G${i}" on Missing_${i}-A`).join(", ")}.`;
    const brief = briefReason(long);
    expect(brief.length).toBeLessThanOrEqual(202);
    expect(brief.endsWith(" …")).toBe(true);
    expect(brief).toMatch(/Missing_6-A, …$/);
    expect(briefReason("found:\n- first\n- second")).toBe("found: - first - second");
  });

  it("says a reason was cut only when it was, not when it was only written over several lines", () => {
    expect(reasonWasCut("found:\n- first\n- second")).toBe(false);
    expect(reasonWasCut("it names no operand.")).toBe(false);
    expect(reasonWasCut(`gates: ${"x".repeat(400)}`)).toBe(true);
  });
});

describe("why a file is paired with no sample", () => {
  const label = (i: number) => `sample ${i + 1} "S${i + 1}.fcs"`;
  it("names the other files that could each be its one sample, and the file that is it", () => {
    // "another file is sample 1" was said of two files neither of which was paired.
    const base = { fileKey: "k", fileName: "a.fcs", why: "ambiguous" as const, candidates: [0], differ: [] };
    expect(describeUnpaired({ ...base, rivals: ["b.fcs"] }, label)).toBe('it and b.fcs could each be sample 1 "S1.fcs", and none was chosen');
    expect(describeUnpaired({ ...base, pairedWith: "b.fcs" }, label)).toBe('b.fcs is sample 1 "S1.fcs"');
    expect(describeUnpaired({ ...base, candidates: [0, 1] }, label)).toBe("2 samples could be it, and none was chosen");
  });
  it("is consistent with the pairing", () => {
    const s = (index: number, name: string): FlowJoSampleSummary => ({
      index, name, owningGroup: "", duplicateName: false, rootCount: 1, candidateFileNames: [name],
      trees: [], eventCount: 3, gateCount: 1, unsupportedCount: 0, recorded: {},
    });
    const pairing = pairFlowJoWorkspaceFiles([s(0, "S1.fcs")], [
      { key: "a", name: "S1.fcs", keywords: { $BTIM: "10:00:00" } },
      { key: "b", name: "b.fcs", keywords: { $BTIM: "11:00:00", $FIL: "S1.fcs" } },
    ]);
    expect(pairing.unpaired.map((u) => describeUnpaired(u, label))).toEqual([
      'it and b.fcs could each be sample 1 "S1.fcs", and none was chosen',
      'it and S1.fcs could each be sample 1 "S1.fcs", and none was chosen',
    ]);
  });
});

describe("holding a file of a name already open", () => {
  it("holds it when its keywords record another acquisition", () => {
    const loaded = [{ name: "Specimen_001_Tube_001.fcs", keywords: { $BTIM: "10:00:00" } }];
    const incoming = [{ name: "Specimen_001_Tube_001.fcs", file: new File([], "x"), keywords: { $BTIM: "15:30:00" } }];
    expect(filesToHold([], loaded, incoming)).toHaveLength(1);
    expect(filesToHold([], loaded, [{ ...incoming[0], keywords: { $BTIM: "10:00:00" } }])).toHaveLength(0);
  });

  it("says which files it did not hold, and as which file", () => {
    // A file of a name already open or held, whose keywords do not contradict it, was dropped
    // without a word: neither loaded nor named.
    const loaded = [{ name: "D1.fcs", keywords: { $BTIM: "10:00:00", $ETIM: "10:01:00" } }];
    const held = [{ name: "D2.fcs", keywords: null }];
    const incoming: { name: string; file: File; keywords: Record<string, string> | null }[] = [
      { name: "d1.FCS", file: new File([], "x"), keywords: { $BTIM: "10:00:00", $ETIM: "10:01:00" } },
      { name: "D2.fcs", file: new File([], "y"), keywords: { $BTIM: "11:00:00" } },
      { name: "D3.fcs", file: new File([], "z"), keywords: null },
    ];
    const skipped: SkippedFile<(typeof incoming)[number]>[] = [];
    expect(filesToHold(held, loaded, incoming, skipped).map((f) => f.name)).toEqual(["D3.fcs"]);
    expect(skipped.map((k) => [k.file.name, k.sameAs.name, k.open, k.confirmed])).toEqual([
      ["d1.FCS", "D1.fcs", true, true],
      ["D2.fcs", "D2.fcs", false, false],
    ]);
  });
});

describe("telling files of one name apart", () => {
  it("says where each is, how many events it holds and when it was recorded, only where a name is shared", () => {
    const names = distinctFileNames([
      { key: "a", name: "D1.fcs", path: "run1/D1.fcs", keywords: { $TOT: "1200", $DATE: "01-JAN-2024", $BTIM: "10:00:00" } },
      { key: "b", name: "d1.fcs", path: "run2/d1.fcs", events: 900, keywords: { $DATE: "02-FEB-2024" } },
      { key: "c", name: "D2.fcs", keywords: { $TOT: "5" } },
    ]);
    expect(names.get("a")).toBe("D1.fcs (run1/D1.fcs · 1,200 events · recorded 01-JAN-2024 10:00:00)");
    expect(names.get("b")).toBe("d1.fcs (run2/d1.fcs · 900 events · recorded 02-FEB-2024)");
    expect(names.get("c")).toBe("D2.fcs");
  });
  it("numbers files nothing else tells apart", () => {
    const names = distinctFileNames([{ key: "a", name: "D1.fcs" }, { key: "b", name: "D1.fcs" }]);
    expect([names.get("a"), names.get("b")]).toEqual(["D1.fcs (file 1)", "D1.fcs (file 2)"]);
  });
  it("names the files in the reason a file is unpaired the same way", () => {
    const names = new Map([["k-a", "D1.fcs (run1/D1.fcs)"], ["k-b", "D1.fcs (run2/D1.fcs)"]]);
    const called = (key: string, name: string) => names.get(key) ?? name;
    const label = (i: number) => `sample ${i + 1} "D1.fcs"`;
    const base = { fileKey: "k-b", fileName: "D1.fcs", why: "ambiguous" as const, candidates: [0], differ: [] };
    // It read "D1.fcs (D1.fcs is sample 1 "D1.fcs")".
    expect(describeUnpaired({ ...base, pairedWith: "D1.fcs", pairedWithKey: "k-a" }, label, called)).toBe('D1.fcs (run1/D1.fcs) is sample 1 "D1.fcs"');
    expect(describeUnpaired({ ...base, rivals: ["D1.fcs"], rivalKeys: ["k-a"] }, label, called))
      .toBe('it and D1.fcs (run1/D1.fcs) could each be sample 1 "D1.fcs", and none was chosen');
  });
});

describe("tiedDataSetsNote", () => {
  const d1 = "plate (data set 1 of 2).fcs";
  const d2 = "plate (data set 2 of 2).fcs";
  const tied = (sampleIndex: number, tiedWith?: string[]): FlowJoFileResolution =>
    ({ sampleIndex, fileName: null, fileKey: null, matchedName: null, status: "missing", ...(tiedWith ? { tiedWith } : {}) });

  it("names every data set left unpaired on a shared event count, once", () => {
    const note = tiedDataSetsNote([tied(0, [d1, d2]), tied(1, [d1, d2]), tied(2)], new Map([[d1, 3], [d2, 3]]));
    expect(note).toBe(
      `${d1} and ${d2} were not paired with a workspace sample: each holds 3 events, a count another data set or ` +
      "workspace sample shares or may share, and no $WELLID or $SMNO says which sample each is. They get the imported tree as drawn, " +
      "without their samples' own coordinates; import gating onto each to choose its sample.");
    expect(tiedDataSetsNote([tied(0, [d1])], new Map([[d1, 1200]])))
      .toMatch(/^plate \(data set 1 of 2\)\.fcs was not paired .*: it holds 1,200 events.* It gets the imported tree as drawn/);
  });

  it("is written in the viewer's language", () => {
    const note = tiedDataSetsNote([tied(0, [d1, d2])], new Map([[d1, 3], [d2, 3]]), (source, values) => translateUi("ja", source, values));
    expect(note).toBe(
      `${d1}、${d2} はワークスペースのどのサンプルとも対応付けられていません。いずれもイベント数 3 で、` +
      "他のデータセットまたはワークスペースのサンプルと同じか、同じ可能性がある数であり、どのサンプルかを示す $WELLID も $SMNO もありません。" +
      "取り込むツリーを描かれたとおりに受け取り、各サンプル自身の座標は使われません。サンプルを選ぶには、それぞれにゲーティングを読み込んでください。");
  });

  it("is null when nothing was left unpaired for a tie", () => {
    expect(tiedDataSetsNote([tied(0), { sampleIndex: 1, fileName: d1, fileKey: d1, matchedName: "plate.fcs", status: "own" }], new Map())).toBeNull();
  });
});

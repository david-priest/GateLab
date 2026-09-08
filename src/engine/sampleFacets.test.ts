import { describe, expect, it } from "vitest";
import {
  allowedByLocks,
  checkedValues,
  columnCoverage,
  facetColumns,
  restrictFacets,
  facetValues,
  groupCheckedCount,
  isAutoFacetColumn,
  toggleGroupChecked,
  type SampleMetadata,
} from "./sampleFacets";

// A miniature of the workspace this exists for: donors crossed with stimulation, in two batches.
const META: SampleMetadata = {
  s1: { donor: "D1", stim: "treated", batch: "B1", run: "r1" },
  s2: { donor: "D1", stim: "control", batch: "B1", run: "r2" },
  s3: { donor: "D2", stim: "treated", batch: "B1", run: "r3" },
  s4: { donor: "D2", stim: "control", batch: "B1", run: "r4" },
  s5: { donor: "D3", stim: "treated", batch: "B2", run: "r5" },
  s6: { donor: "D3", stim: "control", batch: "B2", run: "r6" },
};
const IDS = ["s1", "s2", "s3", "s4", "s5", "s6"];
const COLUMNS = [{ name: "donor" }, { name: "stim" }, { name: "batch" }, { name: "run" }];

describe("choosing which columns become chips", () => {
  it("keeps the columns that divide the samples", () => {
    expect(isAutoFacetColumn(META, "donor")).toBe(true);
    expect(isAutoFacetColumn(META, "stim")).toBe(true);
  });

  it("drops a column that cannot filter anything", () => {
    // One value for every sample: every chip would select the whole workspace.
    const single: SampleMetadata = { a: { panel: "P1" }, b: { panel: "P1" } };
    expect(isAutoFacetColumn(single, "panel")).toBe(false);
  });

  it("drops a column with a value per sample, at any workspace size", () => {
    // `run` is unique per sample; at workspace scale this is a barcode or a well id, and a chip
    // per sample is slower to use than the list it would sit above. Six values is inside the cap,
    // so only comparing against the sample count catches it here.
    expect(isAutoFacetColumn(META, "run")).toBe(false);
    expect(facetColumns(META, COLUMNS).map((column) => column.name))
      .toEqual(["donor", "stim", "batch"]);
  });

  it("honours an explicit column choice over the automatic one", () => {
    // Pinning is the escape hatch: the user's judgement about which columns matter wins.
    expect(facetColumns(META, COLUMNS, ["run"]).map((column) => column.name)).toEqual(["run"]);
    expect(facetColumns(META, COLUMNS, ["donor"]).map((column) => column.name)).toEqual(["donor"]);
  });

  it("carries the samples each value covers", () => {
    expect(facetValues(META, { name: "donor" })).toEqual([
      { value: "D1", sampleIds: ["s1", "s2"] },
      { value: "D2", sampleIds: ["s3", "s4"] },
      { value: "D3", sampleIds: ["s5", "s6"] },
    ]);
  });

  it("takes a declared level order, ignoring levels no sample has", () => {
    const values = facetValues(META, { name: "donor", levels: ["D3", "D1", "D9"] });
    expect(values.map((entry) => entry.value)).toEqual(["D3", "D1"]);
  });
});

// A chip is a bulk checkbox for its group. The checked set drives pooled display, Statistics and
// Proportions, so what a click does to it is the thing worth pinning.
describe("toggling a group", () => {
  const d1 = ["s1", "s2"];
  const all = new Set<string>();
  const none = new Set(IDS);

  it("checks the whole group from nothing checked", () => {
    // The first click on an untouched panel has to select something; anything else reads as broken.
    const next = toggleGroupChecked(d1, none);
    expect(next.has("s1")).toBe(false);
    expect(next.has("s2")).toBe(false);
    expect(next.has("s3")).toBe(true);
  });

  it("unchecks a group that is already fully checked", () => {
    // Clicking a stimulation and then a cell type means "drop that cell type", not "intersect".
    const next = toggleGroupChecked(d1, all);
    expect(next.has("s1")).toBe(true);
    expect(next.has("s2")).toBe(true);
    expect(next.has("s3")).toBe(false);
  });

  it("completes a partly-checked group rather than clearing it", () => {
    // Tri-state checkbox behaviour: the first click on something ambiguous adds.
    const next = toggleGroupChecked(d1, new Set(["s2"]));
    expect(next.has("s1")).toBe(false);
    expect(next.has("s2")).toBe(false);
  });

  it("leaves every sample outside the group alone", () => {
    const before = new Set(["s3", "s5"]);
    const next = toggleGroupChecked(d1, before);
    expect(next.has("s3")).toBe(true);
    expect(next.has("s5")).toBe(true);
    expect(next.has("s4")).toBe(false);
  });

  it("counts how much of a group is checked, which is all a chip shows", () => {
    expect(groupCheckedCount(d1, all)).toBe(2);
    expect(groupCheckedCount(d1, new Set(["s2"]))).toBe(1);
    expect(groupCheckedCount(d1, none)).toBe(0);
  });
});

describe("columns that do not line up with samples", () => {
  // A gate saved into colData reaches the app only for samples whose events were entirely TRUE or
  // entirely FALSE; the rest have no value at all. Two distinct values over three of six samples
  // passes every other test, so coverage is what has to reject it.
  const gated: SampleMetadata = {
    s1: { donor: "D1", CD4_positive: "TRUE" },
    s2: { donor: "D1", CD4_positive: "FALSE" },
    s3: { donor: "D2", CD4_positive: "FALSE" },
    s4: { donor: "D2" },
    s5: { donor: "D3" },
    s6: { donor: "D3" },
  };

  it("counts the samples that carry a value", () => {
    expect(columnCoverage(gated, "CD4_positive")).toBe(3);
    expect(columnCoverage(gated, "donor")).toBe(6);
  });

  it("keeps a partly covered column out of the automatic choice", () => {
    expect(isAutoFacetColumn(gated, "CD4_positive")).toBe(false);
    expect(isAutoFacetColumn(gated, "donor")).toBe(true);
  });

  it("still builds the column when the user pins it, and reports the shortfall", () => {
    const columns = [{ name: "CD4_positive" }];
    const [built] = facetColumns(gated, columns, ["CD4_positive"]);
    expect(built.covered).toBe(3);
    expect(built.sampleCount).toBe(6);
    expect(built.values.map((entry) => entry.value)).toEqual(["TRUE", "FALSE"]);
  });

  it("reports full coverage for a real metadata column", () => {
    const [built] = facetColumns(gated, [{ name: "donor" }], ["donor"]);
    expect(built.covered).toBe(built.sampleCount);
  });
});

describe("holding a row fixed", () => {
  // The workflow this exists for: pick one cell type, then flip the stimulation without the
  // stimulation click dragging in every other cell type.
  const design: SampleMetadata = {
    a: { cell: "CTL", stim: "control" },
    b: { cell: "CTL", stim: "treated" },
    c: { cell: "Naive", stim: "control" },
    d: { cell: "Naive", stim: "treated" },
  };
  const columns = [{ name: "cell" }, { name: "stim" }];
  const facets = facetColumns(design, columns);
  const cell = facets.find((column) => column.name === "cell")!;
  const stim = facets.find((column) => column.name === "stim")!;
  const noneExcluded = new Set<string>();
  const onlyCtl = new Set(["c", "d"]);

  it("freezes on the values that have a checked sample", () => {
    expect(checkedValues(cell, onlyCtl)).toEqual(["CTL"]);
    expect(checkedValues(cell, noneExcluded)).toEqual(["CTL", "Naive"]);
    expect(checkedValues(cell, new Set(["a", "b", "c", "d"]))).toEqual([]);
  });

  it("bounds later clicks to the frozen samples", () => {
    const allowed = allowedByLocks(design, { cell: ["CTL"] });
    expect([...allowed!].sort()).toEqual(["a", "b"]);
  });

  it("does nothing when no row is locked", () => {
    expect(allowedByLocks(design, {})).toBeNull();
    expect(allowedByLocks(design, { cell: [] })).toBeNull();
  });

  it("ignores a lock on a column the workspace no longer has", () => {
    // Obeying it would match no sample and block every click.
    expect(allowedByLocks(design, { gone: ["x"] }, ["cell", "stim"])).toBeNull();
  });

  it("ANDs across two locked rows", () => {
    const allowed = allowedByLocks(design, { cell: ["CTL"], stim: ["treated"] });
    expect([...allowed!]).toEqual(["b"]);
  });

  it("makes a chip say what it will do", () => {
    // Unheld, treated covers two samples; held at CTL it covers one, and the chip must say one.
    expect(stim.values.find((entry) => entry.value === "treated")!.sampleIds).toEqual(["b", "d"]);
    const [, held] = restrictFacets(facets, allowedByLocks(design, { cell: ["CTL"] }));
    expect(held.values.find((entry) => entry.value === "treated")!.sampleIds).toEqual(["b"]);
  });

  it("keeps a value the lock rules out, as an empty group", () => {
    const [heldCell] = restrictFacets(facets, allowedByLocks(design, { cell: ["CTL"] }));
    expect(heldCell.values.map((entry) => entry.value)).toEqual(["CTL", "Naive"]);
    expect(heldCell.values.find((entry) => entry.value === "Naive")!.sampleIds).toEqual([]);
  });

  it("switches the stimulation without leaving the frozen cell type", () => {
    const allowed = allowedByLocks(design, { cell: ["CTL"] })!;
    const within = (value: string) => Object.keys(design)
      .filter((id) => design[id].stim === value && allowed.has(id));
    let excluded: ReadonlySet<string> = onlyCtl;      // CTL only: a and b checked
    excluded = toggleGroupChecked(within("control"), excluded);   // all CTL checked already -> drops a
    expect([...excluded].sort()).toEqual(["a", "c", "d"]);
    excluded = toggleGroupChecked(within("treated"), excluded);   // and drops b, leaving nothing
    expect([...excluded].sort()).toEqual(["a", "b", "c", "d"]);
    excluded = toggleGroupChecked(within("control"), excluded);   // back to CTL AND control, not all control
    expect([...excluded].sort()).toEqual(["b", "c", "d"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  changedStrategyFields,
  FIRST_STRATEGY,
  recordedStrategyStep,
  redoneStrategyStep,
  seenPopulationOf,
  STRATEGY_HISTORY_LIMIT,
  strategyRecordFromSet,
  strategySetFromRecord,
  undoneStrategyStep,
  type StrategyRecord,
  type StrategySet,
  type StrategySettings,
} from "./strategySet";

function settings(overrides: Partial<StrategySettings> = {}): StrategySettings {
  return {
    mode: "single", exportDpi: 300, multiPops: [], popId: "P1", fullPath: false, gateView: ["forward"],
    displayMode: "pseudocolor", maxEvents: 10000, allEvents: false, plotSize: 200, nColumns: 4, fitToColumns: true,
    pointSize: 1.2, pointAlpha: 0.35, contourThreshold: 5, kdeBandwidth: 0, pubStyle: true, gateLineWidth: 1.5,
    fontTick: 12, fontAxis: 12, fontTitle: 12, fontGate: 12,
    ...overrides,
  };
}

const set = (): StrategySet => ({
  activeId: "b",
  strategies: [
    { id: "a", name: "T cells", config: settings({ popId: "P2" }) },
    { id: "b", name: "B cells", config: settings({ mode: "multi", multiPops: ["P3", "P4"] }) },
    { id: "c", name: "Strategy 3", config: null },
  ],
});

describe("the Strategy record and its strategies", () => {
  it("opens a record saved before the tabs as one strategy holding its controls", () => {
    const record = settings({ popId: "P9", exportTree: true });
    expect(strategySetFromRecord(record)).toEqual({ activeId: FIRST_STRATEGY.id, strategies: [{ ...FIRST_STRATEGY, config: record }] });
    expect(seenPopulationOf(record)).toBeUndefined();
  });

  it("opens a workspace with no record as one strategy on the tab's defaults", () => {
    expect(strategySetFromRecord(null)).toEqual({ activeId: FIRST_STRATEGY.id, strategies: [{ ...FIRST_STRATEGY, config: null }] });
  });

  it("writes the shown strategy's controls as the record's own fields and the others in the list", () => {
    const record = strategyRecordFromSet(set(), "P1")!;
    // What a reader of the record that knows nothing of the list sees: the shown strategy.
    expect(record).toMatchObject({ mode: "multi", multiPops: ["P3", "P4"] });
    expect(record.strategies).toEqual({
      activeId: "b",
      items: [{ id: "a", name: "T cells", config: settings({ popId: "P2" }) }, { id: "b", name: "B cells" }, { id: "c", name: "Strategy 3" }],
      seenPopulationId: "P1",
    });
  });

  it("reads back the set it wrote, in order, with each strategy's own controls", () => {
    const record = strategyRecordFromSet(set(), null)!;
    expect(strategySetFromRecord(JSON.parse(JSON.stringify(record)) as StrategyRecord)).toEqual(set());
    expect(seenPopulationOf(record)).toBeNull();
    expect(seenPopulationOf(strategyRecordFromSet(set(), undefined))).toBeUndefined();
  });

  it("has no record to write while the shown strategy has no controls yet", () => {
    expect(strategyRecordFromSet({ ...set(), activeId: "c" }, "P1")).toBeNull();
  });

  it("falls back to the record's own controls when the list cannot be shown", () => {
    const shown = settings({ popId: "P7" });
    const broken: unknown[] = [
      { activeId: "missing", items: [{ id: "a", name: "A" }] },
      { activeId: "a", items: [] },
      { activeId: "a", items: [{ id: "a", name: "A" }, { id: "a", name: "Again" }] },
      { activeId: "a", items: [{ id: "a", name: "A" }, { id: "", name: "No id" }] },
      { activeId: "a", items: "none" },
      "list",
    ];
    for (const strategies of broken) {
      const record = { ...shown, strategies } as unknown as StrategyRecord;
      expect(strategySetFromRecord(record)).toEqual({ activeId: FIRST_STRATEGY.id, strategies: [{ ...FIRST_STRATEGY, config: shown }] });
    }
  });
});

describe("what counts as a change to the shown strategy", () => {
  it("names the controls that differ", () => {
    const after = set();
    after.strategies[1].config = settings({ mode: "multi", multiPops: ["P3"], plotSize: 240 });
    expect(changedStrategyFields(set(), after)?.sort()).toEqual(["multiPops", "plotSize"]);
    expect(changedStrategyFields(set(), set())).toEqual([]);
  });

  it("leaves out the workspace's gate look, which a strategy writes but does not own", () => {
    const after = set();
    after.strategies[1].config = settings({ mode: "multi", multiPops: ["P3", "P4"], pubStyle: false, gateLineWidth: 3, labelBackground: 0.2 });
    expect(changedStrategyFields(set(), after)).toEqual([]);
  });

  it("is null when the strategies themselves differ: another shown, renamed, added or reordered", () => {
    const before = set();
    expect(changedStrategyFields(before, { ...before, activeId: "a" })).toBeNull();
    expect(changedStrategyFields(before, { ...before, strategies: before.strategies.slice(0, 2) })).toBeNull();
    expect(changedStrategyFields(before, { ...before, strategies: before.strategies.map((s) => (s.id === "a" ? { ...s, name: "CD4" } : s)) })).toBeNull();
    expect(changedStrategyFields(before, { ...before, strategies: [before.strategies[1], before.strategies[0], before.strategies[2]] })).toBeNull();
  });
});

describe("the strategies' undo history", () => {
  const named = (name: string): StrategySet => ({ activeId: "a", strategies: [{ id: "a", name, config: null }] });

  it("goes back a step and forward again", () => {
    let history = recordedStrategyStep({ undo: [], redo: [] }, named("one"));
    history = recordedStrategyStep(history, named("two"));
    const back = undoneStrategyStep(history, named("three"))!;
    expect(back.set).toEqual(named("two"));
    const backAgain = undoneStrategyStep(back.history, back.set)!;
    expect(backAgain.set).toEqual(named("one"));
    expect(undoneStrategyStep(backAgain.history, backAgain.set)).toBeNull();
    const forward = redoneStrategyStep(backAgain.history, backAgain.set)!;
    expect(forward.set).toEqual(named("two"));
    expect(redoneStrategyStep(forward.history, forward.set)!.set).toEqual(named("three"));
  });

  it("drops the redo steps when a new step is recorded, and keeps the last steps only", () => {
    const back = undoneStrategyStep(recordedStrategyStep({ undo: [], redo: [] }, named("one")), named("two"))!;
    expect(back.history.redo).toHaveLength(1);
    expect(recordedStrategyStep(back.history, named("other")).redo).toEqual([]);
    let history = { undo: [] as StrategySet[], redo: [] as StrategySet[] };
    for (let i = 0; i < STRATEGY_HISTORY_LIMIT + 5; i++) history = recordedStrategyStep(history, named(String(i)));
    expect(history.undo).toHaveLength(STRATEGY_HISTORY_LIMIT);
    expect(history.undo[0]).toEqual(named("5"));
  });

  it("holds copies, so a set changed later does not change a step", () => {
    const before = named("one");
    const history = recordedStrategyStep({ undo: [], redo: [] }, before);
    before.strategies[0].name = "changed";
    expect(history.undo[0]).toEqual(named("one"));
  });
});

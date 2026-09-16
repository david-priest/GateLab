// Sorts from a synthetic experiment and recordings from synthetic FCS keywords, on one clock.

import { describe, it, expect } from "vitest";
import type { ChorusExperiment, ChorusGate, ChorusRecording } from "./chorusExperiment";
import { buildChorusTimeline, chorusTime } from "./chorusTimeline";

const lin = (id: string) => ({ measurementId: id, fluorochrome: id.split(" ")[0], measurement: "A", scale: "Linear", parameterKind: "Scatter" });
function poly(gateId: string, name: string, parent: string, pts: Array<[number, number]>): ChorusGate {
  return {
    gateId, gateKind: "Polygon", name, parentPopulationId: parent, parameters: [lin("FSC"), lin("SSC")],
    vertices: pts.map(([x, y]) => ({ x, y })), children: [{ name, color: "0,0,0", populationId: `${gateId}-1` }],
  };
}
const CELLS_A = poly("1", "Cells", "0-1", [[0, 0], [10, 0], [10, 10]]);
const CELLS_B = poly("1", "Cells", "0-1", [[0, 0], [12, 0], [12, 12]]);
const SINGLETS = poly("2", "Singlets", "1-1", [[0, 0], [5, 0], [5, 5]]);

function experiment(): ChorusExperiment {
  return {
    id: "exp-1", name: "synthetic sort", recordingCount: 3, savedAt: "2026-01-02T12:00:00", chorusVersion: "5.4.0",
    panels: [{ id: "panel-1", name: "Panel 1", gates: [CELLS_B, SINGLETS], rValues: new Map(), detectors: new Map() }],
    sorts: [
      { name: "Sort_002", startedAt: "2026-01-02T10:00:00", stoppedAt: "2026-01-02T10:20:00", gates: [CELLS_B, SINGLETS], totalEvents: 5000, destinations: [{ population: "Singlets", sortCount: 900, targetCount: 1000 }] },
      { name: "Sort_001", startedAt: "2026-01-02T09:00:00", stoppedAt: "2026-01-02T09:30:00", gates: [CELLS_A, SINGLETS], totalEvents: 4000, destinations: [] },
    ],
  };
}
function recording(name: string, startedAt: string, gates: ChorusGate[], experimentId = "exp-1"): ChorusRecording {
  return {
    dataRecordId: `rec-${name}`, experimentId, experimentName: "synthetic sort", name, category: "Analysis",
    startedAt, stoppedAt: null, eventCount: 100, panel: { id: null, name, gates, rValues: new Map(), detectors: new Map() },
  };
}

describe("the FACSChorus timeline", () => {
  it("reads Chorus's zoneless times as UTC and FCS times with their zone", () => {
    expect(chorusTime("2026-01-02T09:00:00")).toBe(Date.UTC(2026, 0, 2, 9));
    expect(chorusTime("2026-01-02T09:00:00Z")).toBe(Date.UTC(2026, 0, 2, 9));
    expect(chorusTime(null)).toBeNull();
    expect(chorusTime("not a time")).toBeNull();
  });

  it("lays sorts and recordings out in time order, with what each carried", () => {
    const recs = [
      { fileId: "f3", fileName: "D1 during.fcs", recording: recording("D1 during", "2026-01-02T09:10:00Z", [CELLS_A, SINGLETS]) },
      { fileId: "f1", fileName: "D1 pre.fcs", recording: recording("D1 pre", "2026-01-02T08:50:00Z", [CELLS_A, SINGLETS]) },
      { fileId: "f2", fileName: "D2 pre.fcs", recording: recording("D2 pre", "2026-01-02T09:50:00Z", [CELLS_B, SINGLETS], "panel-1") },
      { fileId: "f4", fileName: "other.fcs", recording: recording("other", "2026-01-02T11:00:00Z", [CELLS_A], "exp-9") },
    ];
    const tl = buildChorusTimeline(experiment(), recs);
    expect(tl.items.map((i) => (i.kind === "sort" ? `sort ${i.name}` : `rec ${i.fileName}`))).toEqual([
      "rec D1 pre.fcs", "sort Sort_001", "rec D1 during.fcs", "rec D2 pre.fcs", "sort Sort_002", "rec other.fcs",
    ]);
    const during = tl.items.find((i) => i.kind === "recording" && i.fileName === "D1 during.fcs")!;
    expect(during.kind === "recording" && during.duringSort).toBe("Sort_001");
    const pre = tl.items.find((i) => i.kind === "recording" && i.fileName === "D1 pre.fcs")!;
    expect(pre.kind === "recording" && pre.duringSort).toBeNull();
    expect(pre.kind === "recording" && pre.matchesTrees).toEqual(["Sort_001"]);
    const d2 = tl.items.find((i) => i.kind === "recording" && i.fileName === "D2 pre.fcs")!;
    // The same gates as the live set and as Sort_002's snapshot.
    expect(d2.kind === "recording" && d2.matchesTrees.length).toBe(2);
    expect(d2.kind === "recording" && d2.matchesTrees[0]).toBe("Current gates");
    // Groups number distinct trees in time order: A, then B, then the foreign file's single gate.
    expect(tl.items.filter((i) => i.kind === "recording").map((i) => i.kind === "recording" && i.treeGroup)).toEqual([0, 0, 1, 2]);
    expect(tl.treeGroups).toBe(3);
    const other = tl.items.find((i) => i.kind === "recording" && i.fileName === "other.fcs")!;
    expect(other.kind === "recording" && other.sameExperiment).toBe(false);
    expect(pre.kind === "recording" && pre.sameExperiment).toBe(true);
    expect(d2.kind === "recording" && d2.sameExperiment).toBe(true);
    const sort1 = tl.items.find((i) => i.kind === "sort" && i.name === "Sort_001")!;
    expect(sort1.kind === "sort" && sort1.recordedWith).toEqual(["D1 pre.fcs", "D1 during.fcs"]);
    expect(sort1.kind === "sort" && sort1.totalEvents).toBe(4000);
    const sort2 = tl.items.find((i) => i.kind === "sort" && i.name === "Sort_002")!;
    expect(sort2.kind === "sort" && sort2.sameAsCurrent).toBe(true);
    expect(sort2.kind === "sort" && sort2.sorted).toEqual([{ population: "Singlets", sortCount: 900 }]);
    expect(tl.current).toEqual({ treeIndex: 0, gateCount: 2, savedAt: "2026-01-02T12:00:00" });
    expect(tl.recordingCount).toBe(3);
    expect(tl.span).toEqual({ start: "2026-01-02T08:50:00.000Z", end: "2026-01-02T12:00:00.000Z" });
  });

  it("stands on recordings alone, without an experiment", () => {
    const tl = buildChorusTimeline(null, [
      { fileId: "f1", fileName: "D1.fcs", recording: recording("D1", "2026-01-02T08:50:00Z", [CELLS_A]) },
      { fileId: "f2", fileName: "D2.fcs", recording: recording("D2", "2026-01-02T08:55:00Z", [CELLS_A]) },
    ]);
    expect(tl.items).toHaveLength(2);
    expect(tl.current).toBeNull();
    expect(tl.treeGroups).toBe(1);
    expect(tl.items.every((i) => i.kind === "recording" && i.sameExperiment === null && i.matchesTrees.length === 0)).toBe(true);
  });
});

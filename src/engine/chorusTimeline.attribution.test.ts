// The Chorus timeline credits a recording to the tree it carries: the sort of that snapshot when
// two sorts share a name, and the current gates of the panel it was made in.
import { describe, expect, it } from "vitest";
import type { ChorusExperiment, ChorusGate, ChorusRecording } from "./chorusExperiment";
import { buildChorusTimeline } from "./chorusTimeline";

const lin = (id: string) => ({ measurementId: id, fluorochrome: id.split(" ")[0], measurement: "A", scale: "Linear", parameterKind: "Scatter" });
function poly(gateId: string, name: string, parent: string, pts: Array<[number, number]>): ChorusGate {
  return { gateId, gateKind: "Polygon", name, parentPopulationId: parent, parameters: [lin("FSC"), lin("SSC")],
    vertices: pts.map(([x, y]) => ({ x, y })), children: [{ name, color: "0,0,0", populationId: `${gateId}-1` }] };
}
const A = poly("1", "Cells", "0-1", [[0, 0], [10, 0], [10, 10]]);
const B = poly("1", "Cells", "0-1", [[0, 0], [12, 0], [12, 12]]);
const C = poly("1", "Cells", "0-1", [[0, 0], [14, 0], [14, 14]]);
function rec(name: string, at: string, gates: ChorusGate[]): ChorusRecording {
  return { dataRecordId: name, experimentId: "exp-1", experimentName: "x", name, category: "Analysis", startedAt: at, stoppedAt: null, eventCount: 1,
    panel: { id: null, name, gates, rValues: new Map(), detectors: new Map() } };
}

describe("the Chorus timeline's attribution of recordings", () => {
  it("attributes a recording only to the sort whose snapshot it carries, when two sorts share a name", () => {
    // readChorusExperiment names every unnamed sort "Sort".
    const exp: ChorusExperiment = { id: "exp-1", name: "e", recordingCount: null, savedAt: null, chorusVersion: null,
      panels: [{ id: "p1", name: "P1", gates: [C], rValues: new Map(), detectors: new Map() }],
      sorts: [
        { name: "Sort", startedAt: "2026-01-02T09:00:00", stoppedAt: "2026-01-02T09:30:00", gates: [A], totalEvents: null, destinations: [] },
        { name: "Sort", startedAt: "2026-01-02T10:00:00", stoppedAt: "2026-01-02T10:30:00", gates: [B], totalEvents: null, destinations: [] },
      ] };
    const tl = buildChorusTimeline(exp, [{ fileId: "f1", fileName: "S1.fcs", recording: rec("S1", "2026-01-02T09:10:00Z", [A]) }]);
    const sorts = tl.items.filter((i) => i.kind === "sort");
    expect(sorts.map((s) => s.kind === "sort" && s.recordedWith)).toEqual([["S1.fcs"], []]);
  });

  it("matches a recording to the current gates of the panel it was made in", () => {
    const exp: ChorusExperiment = { id: "exp-1", name: "e", recordingCount: null, savedAt: null, chorusVersion: null,
      panels: [
        { id: "p1", name: "P1", gates: [A], rValues: new Map(), detectors: new Map() },
        { id: "p2", name: "P2", gates: [B], rValues: new Map(), detectors: new Map() },
      ], sorts: [] };
    const tl = buildChorusTimeline(exp, [
      { fileId: "f1", fileName: "S1.fcs", recording: rec("S1", "2026-01-02T09:10:00Z", [A]) },
      { fileId: "f2", fileName: "S2.fcs", recording: rec("S2", "2026-01-02T09:20:00Z", [B]) },
    ]);
    const r = tl.items.filter((i) => i.kind === "recording").map((i) => i.kind === "recording" && [i.fileName, i.matchesTrees]);
    expect(r).toEqual([["S1.fcs", ["Current gates · P1"]], ["S2.fcs", ["Current gates · P2"]]]);
  });
});

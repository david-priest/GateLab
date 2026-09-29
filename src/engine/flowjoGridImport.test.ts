// @vitest-environment jsdom
//
// The FlowJo importer under "Evaluate gates as FlowJo does" (FlowJoImportOptions.flowJoGrid): which
// gates go on FlowJo's grid, which stay continuous and say so, and FlowJo's rectangle rules, each
// against the option off. Synthetic workspace, file, gate and channel names.

import { describe, expect, it } from "vitest";
import { flowJoWorkspaceToGatingML, type FlowJoImportOptions } from "./flowjoWorkspace";
import { importGatingML } from "./gatingml";
import { Sample } from "./sample";
import { applyGatingStrategy } from "./populations";
import type { FcsFile } from "./fcs";
import type { Gate } from "./models";
import { generateBiexLut } from "./biex";
import { exportFlowJoWorkspace } from "./flowjoExport";
import { translateUi } from "../ui/i18n";
import { exportGatingML } from "./gatingmlExport";

const G = "http://www.isac-net.org/std/Gating-ML/v2.0/gating";
const D = "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes";
const T = "http://www.isac-net.org/std/Gating-ML/v2.0/transformations";

// FlowJo writes the gain without a namespace; `prefixed` writes it with one, as a hand-made file might.
const linear = (p: string, min = 0, max = 262144, gain = "1", prefixed = false) =>
  `<transforms:linear transforms:minRange="${min}" transforms:maxRange="${max}" ${prefixed ? "transforms:" : ""}gain="${gain}"><data-type:parameter data-type:name="${p}"/></transforms:linear>`;
const log = (p: string) =>
  `<transforms:log transforms:offset="100" transforms:decades="4"><data-type:parameter data-type:name="${p}"/></transforms:log>`;
const biex = (p: string) =>
  `<transforms:biex transforms:length="256" transforms:maxRange="262144" transforms:neg="0" transforms:width="-10" transforms:pos="4.41854"><data-type:parameter data-type:name="${p}"/></transforms:biex>`;
const dim = (p: string, min?: number, max?: number) =>
  `<gating:dimension${min !== undefined ? ` gating:min="${min}"` : ""}${max !== undefined ? ` gating:max="${max}"` : ""}><data-type:fcs-dimension data-type:name="${p}"/></gating:dimension>`;
const vertex = (x: number, y: number) =>
  `<gating:vertex><gating:coordinate data-type:value="${x}"/><gating:coordinate data-type:value="${y}"/></gating:vertex>`;
const polygon = (name: string, x: string, y: string, attrs = 'quadId="-1" gateResolution="256"') =>
  `<Population name="${name}" count="1"><Gate><gating:PolygonGate ${attrs} gating:id="${name}_g">
    ${dim(x)}${dim(y)}${vertex(20000, 20000)}${vertex(200000, 30000)}${vertex(150000, 220000)}
  </gating:PolygonGate></Gate></Population>`;
const rectangle = (name: string, x: string, y: string, bx: [number?, number?], by: [number?, number?]) =>
  `<Population name="${name}" count="1"><Gate><gating:RectangleGate gating:id="${name}_g">
    ${dim(x, bx[0], bx[1])}${dim(y, by[0], by[1])}
  </gating:RectangleGate></Gate></Population>`;

function workspace(transforms: string, populations: string): string {
  return `<Workspace xmlns:transforms="${T}" xmlns:data-type="${D}" xmlns:gating="${G}"><SampleList><Sample>
    <DataSet uri="file:D1.fcs"/><Keywords><Keyword name="$TIMESTEP" value="0.01"/></Keywords>
    <Transformations>${transforms}</Transformations>
    <SampleNode name="D1.fcs" count="1"><Subpopulations>${populations}</Subpopulations></SampleNode>
  </Sample></SampleList></Workspace>`;
}

const CHANNELS = ["FSC-A", "SSC-A", "Time", "B-A", "L-A", "G-A", "H-A"];
function imported(xml: string, options: FlowJoImportOptions) {
  const conv = flowJoWorkspaceToGatingML(xml, 0, null, undefined, options);
  const res = importGatingML(conv.gatingMl, CHANNELS, {}, "flow");
  const byName = (name: string): Gate => Object.values(res.gates).find((g) => g.name === name)!;
  return { conv, res, byName };
}

describe("which FlowJo polygons go on FlowJo's grid", () => {
  const xml = workspace(
    linear("FSC-A") + linear("SSC-A") + linear("Time", 0, 5000) + log("L-A") + biex("B-A") + linear("G-A", 0, 262144, "2")
      + linear("H-A", 0, 262144, "2", true),
    polygon("Scatter", "FSC-A", "SSC-A")
      + polygon("Mixed", "B-A", "L-A")
      + polygon("OnTime", "Time", "SSC-A")
      + polygon("Gained", "G-A", "SSC-A")
      + polygon("GainedPrefixed", "H-A", "SSC-A")
      + polygon("Panel", "FSC-A", "SSC-A", 'quadId="2" gateResolution="256"')
      + polygon("Unresolved", "FSC-A", "SSC-A", 'quadId="-1"'),
  );

  it("puts a polygon on linear, log and biex axes on the grid, vertices on channels, FlowJo's own beside them", () => {
    const { conv, byName } = imported(xml, { flowJoGrid: true });
    expect(conv.gridPolygons).toBe(2);
    for (const name of ["Scatter", "Mixed"]) {
      const g = byName(name);
      expect(g.gate_type).toBe("polygon");
      if (g.gate_type !== "polygon") continue;
      expect(g.space).toBe("display");
      expect(Object.values(g.transforms!).map((t) => t.kind)).toEqual(["flowjoChannels", "flowjoChannels"]);
      expect(g.vertices.flat().every(Number.isInteger)).toBe(true);
      expect(g.flowjo_vertices).toEqual([[20000, 20000], [200000, 30000], [150000, 220000]]);
    }
    // 1024 per channel on the linear axes: 20000 is channel 19.53, which rounds to 20.
    const scatter = byName("Scatter");
    expect(scatter.gate_type === "polygon" && scatter.vertices[0]).toEqual([20, 20]);
    const mixed = byName("Mixed");
    const [bx, ly] = [mixed.transforms!["B-A"], mixed.transforms!["L-A"]];
    expect(bx).toMatchObject({ kind: "flowjoChannels", channels: 256, axis: { kind: "biex", widthBasis: -10 } });
    expect(ly).toMatchObject({ kind: "flowjoChannels", channels: 256, axis: { kind: "wsplog", offset: 100, decades: 4 } });
  });

  it("leaves continuous, and names, the polygons FlowJo's rule is not established for", () => {
    const { conv, byName } = imported(xml, { flowJoGrid: true });
    for (const name of ["OnTime", "Gained", "GainedPrefixed", "Panel", "Unresolved"]) {
      const kinds = Object.values(byName(name).transforms ?? {}).map((t) => t.kind);
      expect(kinds, name).not.toContain("flowjoChannels");
    }
    const note = conv.warnings.find((w) => /evaluated continuously rather than on FlowJo's grid/.test(w))!;
    expect(note).toMatch(/"OnTime" is on a Time axis/);
    expect(note).toMatch(/"Gained" is on G-A, whose axis FlowJo's grid is not established for/);
    expect(note).toMatch(/"GainedPrefixed" is on H-A/);
    expect(note).toMatch(/"Panel" is a panel of a quadrant gate/);
    expect(note).toMatch(/"Unresolved" declares no gate resolution/);
  });

  // Every corpus polygon that declares a resolution declares 256. Another is put on a grid of that
  // many channels, the rule taken at its word, and said: it was done without a word, although no
  // count at another resolution has been compared with FlowJo's.
  it("puts a polygon with another gate resolution on a grid of that many channels, and says it is not measured", () => {
    const other = workspace(linear("FSC-A") + linear("SSC-A"),
      polygon("Coarse", "FSC-A", "SSC-A", 'quadId="-1" gateResolution="128"') + polygon("Scatter", "FSC-A", "SSC-A"));
    const { conv, byName } = imported(other, { flowJoGrid: true });
    expect(Object.values(byName("Coarse").transforms!).map((t) => (t as { channels?: number }).channels)).toEqual([128, 128]);
    const note = conv.warnings.find((w) => /gate resolution other than 256/.test(w));
    expect(note).toMatch(/"Coarse" \(128\)/);
    expect(note).not.toMatch(/Scatter/);
  });

  it("puts nothing on the grid with the option off, and says nothing about it", () => {
    const { conv, byName } = imported(xml, { flowJoGrid: false });
    expect(conv.gridPolygons).toBe(0);
    expect(conv.warnings.some((w) => /FlowJo's grid/.test(w))).toBe(false);
    const scatter = byName("Scatter");
    expect(scatter.space ?? "raw").toBe("raw");
    expect(scatter.gate_type === "polygon" && scatter.vertices[0]).toEqual([20000, 20000]);
    expect(Object.values(byName("Mixed").transforms!).map((t) => t.kind)).toEqual(["biex", "wsplog"]);
  });

  it("evaluates FlowJo's biex on FlowJo's table in both modes", () => {
    for (const flowJoGrid of [true, false]) {
      const conv = flowJoWorkspaceToGatingML(workspace(biex("B-A") + biex("L-A"), rectangle("R", "B-A", "L-A", [100, 1000], [100, 1000])), 0, null, undefined, { flowJoGrid });
      const res = importGatingML(conv.gatingMl, CHANNELS, {}, "flow");
      const g = Object.values(res.gates)[0];
      if (!flowJoGrid) expect(Object.values(g.transforms!).map((t) => (t as { tableChannels?: number }).tableChannels)).toEqual([4096, 4096]);
      else expect(g.gate_type === "rectangle" && Object.values(g.flowjo_axes ?? {}).length).toBe(2);
    }
  });
});

function fcs(columns: Record<string, number[]>): FcsFile {
  const names = Object.keys(columns);
  const n = columns[names[0]].length;
  return {
    version: "FCS3.1", nEvents: n, instrument: "flow", keywords: {},
    channels: names.map((name, index) => ({ index, name, marker: null, bits: 32, range: 262144 })),
    columns: names.map((name) => Float32Array.from(columns[name])),
    spillover: null,
  } as unknown as FcsFile;
}
function membership(xml: string, options: FlowJoImportOptions, columns: Record<string, number[]>): Record<string, number[]> {
  const conv = flowJoWorkspaceToGatingML(xml, 0, null, undefined, options);
  const sample = new Sample(fcs(columns));
  const res = importGatingML(conv.gatingMl, sample.channels.map((c) => c.key), {}, sample.instrument);
  const { masks } = applyGatingStrategy(res.gates, res.populations, res.root_population_id, sample.gateAssayData());
  const out: Record<string, number[]> = {};
  for (const [pid, pop] of Object.entries(res.populations)) if (pid !== res.root_population_id) out[pop.name] = Array.from(masks[pid]);
  return out;
}

describe("FlowJo's rectangle rules", () => {
  it("opens a linear bound at or beyond the axis's range, with the option on only", () => {
    // Axis 0..100000; the rectangle reaches 0 and 100000 exactly. FlowJo moves events beyond the
    // axis onto its edges, so they are in; continuously they are not.
    const xml = workspace(linear("FSC-A", 0, 100000) + linear("SSC-A", 0, 100000),
      rectangle("Box", "FSC-A", "SSC-A", [0, 100000], [0, 50000]));
    const events = { "FSC-A": [-500, 50000, 150000, 50000], "SSC-A": [100, 100, 100, 60000] };
    expect(membership(xml, { flowJoGrid: true }, events).Box).toEqual([1, 1, 1, 0]);
    expect(membership(xml, { flowJoGrid: false }, events).Box).toEqual([0, 1, 0, 0]);
  });

  it("keeps a bound wholly beyond the axis raw", () => {
    const xml = workspace(linear("FSC-A", 0, 100000) + linear("SSC-A", 0, 100000),
      rectangle("Beyond", "FSC-A", "SSC-A", [150000, 200000], [0, 50000]));
    const events = { "FSC-A": [160000, 250000], "SSC-A": [100, 100] };
    expect(membership(xml, { flowJoGrid: true }, events).Beyond).toEqual([1, 0]);
  });

  it("compares a biex rectangle in raw units: nothing pinned at the table's top, the bottom pinned", () => {
    const { x } = generateBiexLut({ maxValue: 262144, pos: 4.41854, neg: 0, widthBasis: -10, channelRange: 256, tableChannels: 4096 });
    const top = x[4096];
    const bottom = x[0];
    expect(top).toBeLessThan(262144);
    const xml = workspace(biex("B-A") + biex("L-A"),
      rectangle("High", "B-A", "L-A", [1000, top * 1.2], [-1e6, 1e7])
      + rectangle("Low", "B-A", "L-A", [bottom - 10, 1000], [-1e6, 1e7])
      + rectangle("JustAbove", "B-A", "L-A", [bottom + 10, 1000], [-1e6, 1e7]));
    // Beyond the top but under the bound; beyond the bound; below the table; between the bottom and
    // the bound just above it.
    const events = { "B-A": [top * 1.1, top * 1.5, bottom - 5000, bottom + 5], "L-A": [0, 0, 0, 0] };
    const on = membership(xml, { flowJoGrid: true }, events);
    expect(on.High).toEqual([1, 0, 0, 0]);
    expect(on.Low).toEqual([0, 0, 1, 1]); // the event below the table sits on its bottom, inside
    expect(on.JustAbove).toEqual([0, 0, 0, 0]); // pinned onto the bottom, below the bound
    // Continuously, on the display: both ends pin, so the event beyond the bound lands on the top
    // channel with the bound and is in.
    const off = membership(xml, { flowJoGrid: false }, events);
    expect(off.High).toEqual([1, 1, 0, 0]);
  });

  // A histogram's range is one dimension, which no display space holds, so it is compared in raw
  // units; FlowJo pins an event below a log axis's offset onto it. FR-FCM-Z466's "PE-A-", from the
  // offset up, counted 73 of FlowJo's 2,256 before.
  it("takes the events below a log axis's offset into a range from the offset, with the option on only", () => {
    const range = (name: string, ch: string, lo: number, hi: number) =>
      `<Population name="${name}" count="1"><Gate><gating:RectangleGate gating:id="${name}_g">${dim(ch, lo, hi)}</gating:RectangleGate></Gate></Population>`;
    const xml = workspace(log("L-A"), range("Low", "L-A", 100, 140) + range("Above", "L-A", 120, 140));
    const events = { "L-A": [-50, 0, 99, 100, 130, 150] };
    const on = membership(xml, { flowJoGrid: true }, events);
    expect(on.Low).toEqual([1, 1, 1, 1, 1, 0]);
    expect(on.Above).toEqual([0, 0, 0, 0, 1, 0]);
    expect(membership(xml, { flowJoGrid: false }, events).Low).toEqual([0, 0, 0, 1, 1, 0]);
  });

  // A range on Time is in FlowJo's seconds; the file's events are in ticks ($TIMESTEP 0.01 here).
  // The step was applied to a two-dimensional gate only, so [10, 50] s was read as ticks 10 to 50.
  it("reads a range on Time in seconds, as the events' ticks times $TIMESTEP, under either answer", () => {
    const range = `<Population name="Window" count="1"><Gate><gating:RectangleGate gating:id="Window_g">${dim("Time", 10, 50)}</gating:RectangleGate></Gate></Population>`;
    const xml = workspace(linear("Time", 0, 5000), range);
    // Ticks: 5 s, 10 s, 30 s, 50 s, 60 s, and 30 ticks (0.3 s), which the unconverted range took.
    const events = { Time: [500, 1000, 3000, 5000, 6000, 30] };
    for (const flowJoGrid of [true, false]) {
      expect(membership(xml, { flowJoGrid }, events).Window, String(flowJoGrid)).toEqual([0, 1, 1, 1, 0, 0]);
    }
  });

  // FlowJo saves a Time gate in the units of its Time axis: the stored ticks times the axis's
  // linear gain, which FlowJo 10 sets to the recording's duration over the Time column's span, close
  // to $TIMESTEP but not it. Read at $TIMESTEP (0.01 here), 22 of the corpus ladder's 27 root Time
  // rectangles missed FlowJo's count (FR-FCM-Z2HV 27,832 against 28,033, Z2W3 23,179 against
  // 22,891, Z2C8 186,561 against 186,067). An upper bound past the axis's maximum is opened as on
  // any linear axis: Z2HV's 77.32 on an axis to 77, which kept out 91 events FlowJo counts.
  it("reads a Time rectangle at the gain the workspace declares for Time, its range opening a bound past it", () => {
    // Z2HV's sample 14: gain 0.0102350064, axis 0.5107 to 77, the gate 12.0805 to 77.3214.
    const xml = workspace(linear("Time", 0.5107268184, 77, "0.0102350064") + linear("SSC-A", 0, 262144),
      rectangle("Time window", "Time", "SSC-A", [12.080532845847822, 77.32138350076312], [18204.444444444445, 229376]));
    // Ticks: just below the lower bound at the gain; just above it (below it at $TIMESTEP); one at
    // 1200 (12.28 at the gain, 12.00 at $TIMESTEP); and 7560 (77.38 at the gain, past the gate's
    // 77.32 and the axis's 77).
    const events = { Time: [1180.3, 1180.4, 1200, 7560], "SSC-A": [50000, 50000, 50000, 50000] };
    expect(membership(xml, { flowJoGrid: true }, events)["Time window"]).toEqual([0, 1, 1, 1]);
    // The gain whatever the answer; the range's rule with the option on only.
    expect(membership(xml, { flowJoGrid: false }, events)["Time window"]).toEqual([0, 1, 1, 0]);
  });

  it("reads Time at $TIMESTEP where the workspace declares a gain of 1, and at the gain where it states no $TIMESTEP", () => {
    // FR-FCM-Z282 (FlowJo 10.0.8): gain 1 and $TIMESTEP 0.001; FlowJo counts its Time gate at
    // $TIMESTEP (186,922), not at the gain (196).
    const one = workspace(linear("Time", 0, 5000, "1"), `<Population name="Window" count="1"><Gate><gating:RectangleGate gating:id="Window_g">${dim("Time", 10, 50)}</gating:RectangleGate></Gate></Population>`);
    expect(membership(one, { flowJoGrid: true }, { Time: [500, 1000, 3000, 5000, 6000, 30] }).Window).toEqual([0, 1, 1, 1, 0, 0]);
    // FR-FCM-Z2MW, mass cytometry: no $TIMESTEP, gain 0.0010022058; FlowJo's 396,964 for its
    // "Time, 140Ce_Bead subset" at the gain, 458 taking Time as stored.
    const noStep = workspace(linear("Time", 0, 1061, "0.001"), `<Population name="Window" count="1"><Gate><gating:RectangleGate gating:id="Window_g">${dim("Time", 10, 50)}</gating:RectangleGate></Gate></Population>`)
      .replace('<Keyword name="$TIMESTEP" value="0.01"/>', "");
    expect(membership(noStep, { flowJoGrid: true }, { Time: [5000, 10000, 30000, 50000, 60000, 30] }).Window).toEqual([0, 1, 1, 1, 0, 0]);
  });

  // A rectangle wholly below where FlowJo pins (a biex table's bottom, a log axis's offset) holds
  // no event under FlowJo's rule: every event is at or above the pin, and so above the rectangle.
  // Opening its lower bound made it take every event below its upper one instead. It is counted
  // as drawn, as a rectangle wholly beyond a linear axis is (#343), and named, since FlowJo's own
  // count for one has not been measured; the reference implementation counts none.
  it("counts a rectangle wholly below a biex table's bottom or a log axis's offset as drawn, and names it", () => {
    const { x } = generateBiexLut({ maxValue: 262144, pos: 4.41854, neg: 0, widthBasis: -10, channelRange: 256, tableChannels: 4096 });
    const bottom = x[0];
    const range = (name: string, ch: string, lo: number, hi: number) =>
      `<Population name="${name}" count="1"><Gate><gating:RectangleGate gating:id="${name}_g">${dim(ch, lo, hi)}</gating:RectangleGate></Gate></Population>`;
    const xml = workspace(biex("B-A") + log("L-A") + linear("SSC-A", 0, 100000),
      rectangle("UnderTable", "B-A", "SSC-A", [bottom - 5000, bottom - 100], [0, 50000])
      + range("UnderOffset", "L-A", 10, 50)
      + rectangle("UnderOffset2D", "L-A", "SSC-A", [10, 50], [0, 50000]));
    const events = {
      "B-A": [bottom - 6000, bottom - 3000, bottom - 50, bottom + 5],
      "L-A": [-5, 20, 60, 150],
      "SSC-A": [100, 100, 100, 100],
    };
    const on = membership(xml, { flowJoGrid: true }, events);
    expect(on.UnderTable).toEqual([0, 1, 0, 0]);
    expect(on.UnderOffset).toEqual([0, 1, 0, 0]);
    expect(on.UnderOffset2D).toEqual([0, 1, 0, 0]);
    const notes = flowJoWorkspaceToGatingML(xml, 0, null, undefined, { flowJoGrid: true }).warnings.join(" ");
    for (const name of ["UnderTable", "UnderOffset", "UnderOffset2D"]) expect(notes).toContain(`"${name}" lies wholly below`);
    // In the language the app is in, when it passes its translation.
    const ja = flowJoWorkspaceToGatingML(xml, 0, null, undefined, { flowJoGrid: true, translate: (text, values) => translateUi("ja", text, values) }).warnings.join(" ");
    expect(ja).toContain("「UnderTable」はB-A上でFlowJoのbiexテーブルの下端（");
    expect(ja).toContain("「UnderOffset」はL-A上でlog軸のオフセット（100）より完全に下にあります。");
    expect(ja).not.toContain("lies wholly below");
  });

  // FlowJo compares a rectangle in raw units whatever the axis, pinning only at the bottom of a
  // biex or log axis (the reference implementation's rule). A two-dimensional rectangle on a log
  // axis was held on the log display instead, which pins the rectangle's bounds at the offset with
  // the events, so one wholly below the offset took every event below it (the test above). Held in
  // raw units, it follows the same rule as a range; nothing is pinned at the log axis's top.
  it("compares a two-dimensional log rectangle in raw units, as it does a range", () => {
    const xml = workspace(log("L-A") + linear("SSC-A", 0, 100000),
      rectangle("High", "L-A", "SSC-A", [200, 2e6], [0, 50000]));
    // The log axis ends at 100 · 10^4 = 1e6: one event past it under the bound, one past the bound.
    const events = { "L-A": [150, 5000, 1.5e6, 3e6], "SSC-A": [100, 100, 100, 100] };
    expect(membership(xml, { flowJoGrid: true }, events).High).toEqual([0, 1, 1, 0]);
    const { byName } = imported(xml, { flowJoGrid: true });
    expect(byName("High").space ?? "raw").toBe("raw");
  });

  it("keeps the axes a rule-imported rectangle was saved on, for the FlowJo export", () => {
    const xml = workspace(biex("B-A") + linear("SSC-A", 0, 100000), rectangle("Box", "B-A", "SSC-A", [100, 1000], [0, 5000]));
    const { byName } = imported(xml, { flowJoGrid: true });
    const box = byName("Box");
    expect(box.space ?? "raw").toBe("raw");
    expect(box.gate_type === "rectangle" && box.flowjo_axes).toEqual({
      "B-A": { kind: "biex", maxValue: 262144, pos: 4.41854, neg: 0, widthBasis: -10, channelRange: 256 },
      "SSC-A": { kind: "linear", minRange: 0, maxRange: 100000 },
    });
    const off = imported(xml, { flowJoGrid: false }).byName("Box");
    expect(off.gate_type === "rectangle" && off.flowjo_axes).toBeUndefined();
  });
});

/** Import, export to a FlowJo workspace, and import that again, each with its own option. */
function reexported(xml: string, first: FlowJoImportOptions, columns: Record<string, number[]>) {
  const conv = flowJoWorkspaceToGatingML(xml, 0, null, undefined, first);
  const sample = new Sample(fcs(columns));
  const res = importGatingML(conv.gatingMl, sample.channels.map((c) => c.key), {}, sample.instrument);
  const { xml: wsp } = exportFlowJoWorkspace({
    samples: [{ sample, fileName: "D1.fcs", gates: res.gates, gate_order: res.gate_order, populations: res.populations, root_population_id: res.root_population_id }],
    now: new Date("2026-09-25T00:00:00Z"), producer: "GateLab test",
  });
  return { wsp, again: (options: FlowJoImportOptions) => membership(wsp, options, columns) };
}

describe("FlowJo's rectangles exported to a FlowJo workspace again", () => {
  // A bound FlowJo's rule opened went out as -1e9, the importer's stand-in for no bound: FlowJo
  // selected the same events from it, but it was not FlowJo's bound, and an import of the file
  // with the option off took every event past it. The file now holds FlowJo's own bound, and the
  // option decides again on the way back.
  it("writes FlowJo's own bound where the rule opened one, so the option decides again", () => {
    const { x } = generateBiexLut({ maxValue: 262144, pos: 4.41854, neg: 0, widthBasis: -10, channelRange: 256, tableChannels: 4096 });
    const bottom = x[0];
    const xml = workspace(biex("B-A") + linear("SSC-A", 0, 100000),
      rectangle("Box", "B-A", "SSC-A", [bottom - 100, 1000], [-50, 50000]));
    const events = { "B-A": [bottom - 500, bottom - 50, 500, 500, 2000], "SSC-A": [100, 100, 100, -80, 100] };
    const on = membership(xml, { flowJoGrid: true }, events).Box;
    const off = membership(xml, { flowJoGrid: false }, events).Box;
    expect(on).not.toEqual(off);
    const { wsp, again } = reexported(xml, { flowJoGrid: true }, events);
    const rect = wsp.match(/<gating:RectangleGate[\s\S]*?<\/gating:RectangleGate>/)![0];
    expect(rect).toContain(`gating:min="${bottom - 100}"`);
    expect(rect).toContain('gating:min="-50"');
    expect(rect).not.toMatch(/1000000000|e\+/);
    expect(again({ flowJoGrid: true }).Box).toEqual(on);
    expect(again({ flowJoGrid: false }).Box).toEqual(off);
  });

  // An open bound held in a log display went out through the axis's inverse, which is Infinity,
  // and the writer wrote a non-finite number as 0: the rectangle's upper bound became 0 and it
  // held nothing (244 corpus quadrant rectangles flipped). FlowJo writes no bound there, and so
  // does the export now, on any axis.
  it("leaves an open bound out of the file, on a log axis too, rather than writing it as a number", () => {
    const xml = workspace(log("L-A") + linear("SSC-A", 0, 100000),
      rectangle("Upper", "L-A", "SSC-A", [500, undefined], [3000, undefined]));
    const events = { "L-A": [50, 3000, 8000, 8000], "SSC-A": [4000, 4000, 4000, 100] };
    for (const flowJoGrid of [false, true]) {
      const first = membership(xml, { flowJoGrid }, events).Upper;
      expect(first).toEqual([0, 1, 1, 0]);
      const { wsp, again } = reexported(xml, { flowJoGrid }, events);
      const rect = wsp.match(/<gating:RectangleGate[\s\S]*?<\/gating:RectangleGate>/)![0];
      expect(rect).not.toContain("gating:max");
      expect(again({ flowJoGrid }).Upper).toEqual(first);
    }
  });
});

describe("FlowJo's continuous polygons exported to a FlowJo workspace again", () => {
  // A quadrant panel (quadId 0 to 3) and a polygon with no gateResolution stay continuous under
  // FlowJo's rule, since FlowJo's own rule for them is not established. The export wrote both as
  // ordinary polygons (quadId -1, gateResolution 256), so FlowJo, and an import with the option on,
  // put them on the grid: they moved on the way back. Their own attributes now go back out.
  it("writes a quadrant panel's quadId and a missing gateResolution back, so neither is gridded on the way back", () => {
    const xml = workspace(linear("FSC-A") + linear("SSC-A"),
      polygon("Panel", "FSC-A", "SSC-A", 'quadId="2" gateResolution="256"')
      + polygon("Unresolved", "FSC-A", "SSC-A", 'quadId="-1"'));
    // Events either side of the polygons' edges, where a grid cell and the drawn line disagree.
    const xs: number[] = [];
    const ys: number[] = [];
    for (let k = 0; k < 400; k++) { xs.push(20000 + 450 * k); ys.push(20000 + 500 * ((k * 37) % 400)); }
    const events = { "FSC-A": xs, "SSC-A": ys };
    // The events tell the polygon on the grid from the polygon as drawn.
    const gridded = membership(xml.replace('quadId="2"', 'quadId="-1"'), { flowJoGrid: true }, events).Panel;
    expect(gridded).not.toEqual(membership(xml, { flowJoGrid: true }, events).Panel);
    for (const flowJoGrid of [true, false]) {
      const first = membership(xml, { flowJoGrid }, events);
      const { wsp, again } = reexported(xml, { flowJoGrid }, events);
      const polygons = [...wsp.matchAll(/<gating:PolygonGate[^>]*>/g)].map((m) => m[0]);
      expect(polygons.some((p) => /quadId="2"/.test(p) && /gateResolution="256"/.test(p))).toBe(true);
      expect(polygons.some((p) => /quadId="-1"/.test(p) && !/gateResolution/.test(p))).toBe(true);
      const back = again({ flowJoGrid });
      expect(back.Panel).toEqual(first.Panel);
      expect(back.Unresolved).toEqual(first.Unresolved);
    }
  });
});

// What the FlowJo export needs of a FlowJo gate (the axes and bounds a rule-imported rectangle was
// saved with, a continuous polygon's own attributes) rides through GateLab's own Gating-ML export
// and back, as a grid polygon's mark does; it was dropped, and a later FlowJo export declared other
// axes and wrote the rule's open bound.
describe("FlowJo's own attributes through GateLab's Gating-ML export", () => {
  it("keeps a rule-imported rectangle's axes and bounds and a panel's quadId", () => {
    const { x } = generateBiexLut({ maxValue: 262144, pos: 4.41854, neg: 0, widthBasis: -10, channelRange: 256, tableChannels: 4096 });
    const xml = workspace(biex("B-A") + linear("SSC-A", 0, 100000),
      rectangle("Box", "B-A", "SSC-A", [x[0] - 100, 1000], [-50, 50000])
      + polygon("Panel", "B-A", "SSC-A", 'quadId="1" gateResolution="256"'));
    const conv = flowJoWorkspaceToGatingML(xml, 0, null, undefined, { flowJoGrid: true });
    const sample = new Sample(fcs({ "B-A": [0, 500], "SSC-A": [100, 100] }));
    const res = importGatingML(conv.gatingMl, sample.channels.map((c) => c.key), {}, sample.instrument);
    const byName = (r: typeof res, name: string) => Object.values(r.gates).find((g) => g.name === name)!;
    for (const format of ["standard", "cytobank"] as const) {
      const gml = exportGatingML({ gates: res.gates, gate_order: res.gate_order, populations: res.populations, root_population_id: res.root_population_id, sample, format, allowQuadrantOmission: true });
      const back = importGatingML(gml, sample.channels.map((c) => c.key), {}, sample.instrument);
      const box = byName(back, "Box");
      const box0 = byName(res, "Box");
      expect(box.gate_type === "rectangle" && box.flowjo_axes, format).toEqual(box0.gate_type === "rectangle" && box0.flowjo_axes);
      expect(box.gate_type === "rectangle" && box.flowjo_bounds, format).toEqual({ "B-A": [x[0] - 100, null], "SSC-A": [-50, null] });
      const panel = byName(back, "Panel");
      expect(panel.gate_type === "polygon" && panel.flowjo_polygon, format).toEqual({ quadId: 1, gateResolution: 256 });
    }
  });
});

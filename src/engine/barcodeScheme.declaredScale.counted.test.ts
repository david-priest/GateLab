import { describe, expect, it } from "vitest";
import { buildBarcodeGating, parseBarcodeTable, resolveBarcodeScheme } from "./barcodeScheme";
import { DEFAULT_BARCODE_TEMPLATE, learnBarcodeTemplate } from "./barcodeTemplate";
import { getGateMask } from "./gates";
import type { Gate, PolyRectGate } from "./models";

// A barcode gate declared on a "# gate:" line is held in arcsinh at the sample's cofactor, so the
// line's own scale has to be brought to it. Events are given in raw values and counted.

const channels = [
  { key: "113In", pnn: "In113Di", marker: null },
  { key: "115In", pnn: "In115Di", marker: null },
];

/** The events (raw 115In, raw 113In) a built gate holds, at the gate's own recorded cofactor. */
function members(gate: PolyRectGate, events: [number, number][]): number[] {
  const column = (channel: string) => {
    const spec = gate.transforms?.[channel];
    const cofactor = spec && spec.kind === "asinh" ? spec.cofactor : 1;
    return Float64Array.from(events, (e) => Math.asinh((channel === "115In" ? e[0] : e[1]) / cofactor));
  };
  return Array.from(getGateMask(gate, { n: events.length, column } as never));
}

function built(gateLines: string[], cofactor: number): Record<string, PolyRectGate> {
  const text = ["# plane: 115In x 113In", ...gateLines, "name,113In,115In", "D1,1,0", "D2,0,1"].join("\n");
  const scheme = resolveBarcodeScheme(parseBarcodeTable(text), channels);
  expect(scheme.problems).toEqual([]);
  const gating = buildBarcodeGating(scheme, DEFAULT_BARCODE_TEMPLATE, cofactor, { channels });
  return Object.fromEntries(Object.values(gating.gates).map((g) => [g.name, g as PolyRectGate]));
}

describe("a barcode polygon declared in the scheme file", () => {
  // 115In from 0 to 10 and 113In from 100 to 200, in raw values: the first event is inside.
  const events: [number, number][] = [[5, 150], [5, 50], [50, 150]];

  it("written in raw values holds the events inside those values", () => {
    const gates = built(["# gate: 113+115- | polygon | 115In x 113In | raw | (0,100) (10,100) (10,200) (0,200)"], 4);
    expect(members(gates["113+115-"], events)).toEqual([1, 0, 0]);
  });

  it("written in arcsinh at another cofactor holds the same raw values", () => {
    const a = (v: number) => Math.asinh(v / 5).toFixed(6);
    const line = `# gate: 113+115- | polygon | 115In x 113In | asinh(5) | (${a(0)},${a(100)}) (${a(10)},${a(100)}) (${a(10)},${a(200)}) (${a(0)},${a(200)})`;
    expect(members(built([line], 4)["113+115-"], events)).toEqual([1, 0, 0]);
    // An event at raw 115In 11.5: outside 0 to 10, and inside the gate when the vertices written at
    // cofactor 5 were taken as cofactor 4's (asinh(10/5) as asinh(x/4) reaches raw 14.5).
    expect(members(built([line], 4)["113+115-"], [[11.5, 150]])).toEqual([0]);
    expect(members(built([line], 5)["113+115-"], events)).toEqual([1, 0, 0]);
  });
});

describe("learning a barcode template", () => {
  it("keeps channel keys that hold a space", () => {
    const x = "115In CD4";
    const y = "113In CD3";
    const box = (id: string, cx: number, cy: number): Gate => ({
      gate_id: id, name: id, gate_type: "polygon", x_channel: x, y_channel: y, color: "#000000", label_offset: null, space: "display",
      vertices: [[cx - 0.5, cy - 0.5], [cx + 0.5, cy - 0.5], [cx + 0.5, cy + 0.5], [cx - 0.5, cy + 0.5]],
      transforms: { [x]: { kind: "asinh", cofactor: 5 }, [y]: { kind: "asinh", cofactor: 5 } },
    } as PolyRectGate);
    const learned = learnBarcodeTemplate([box("a", 0, 0), box("b", 4, 0), box("c", 0, 4), box("d", 4, 4)], 5);
    expect(learned?.planes.map((p) => [p.x, p.y])).toEqual([[x, y]]);
  });
});

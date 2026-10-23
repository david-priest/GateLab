import { describe, expect, it } from "vitest";
import { DEFAULT_GATE_LINE_WIDTH, GATE_INK, displayGateColour, inkedForDisplay, restoredColouredGates, restoredGateLabelBackground, restoredGateLineWidth } from "./gateInk";

describe("gate ink and line width", () => {
  it("opens a workspace saved before the controls black, at 1.2, labels on an 85% backing", () => {
    expect(restoredColouredGates(undefined)).toBe(false);
    expect(restoredGateLabelBackground(undefined)).toBe(0.85);
    expect(restoredGateLineWidth(undefined)).toBe(DEFAULT_GATE_LINE_WIDTH);
    expect(restoredGateLineWidth(null)).toBe(1.2);
    expect(restoredGateLineWidth("")).toBe(1.2);
    expect(restoredGateLineWidth("wide")).toBe(1.2);
  });

  it("restores what was saved, clamping the width to the slider's range", () => {
    expect(restoredColouredGates(false)).toBe(false);
    expect(restoredColouredGates(true)).toBe(true);
    expect(restoredColouredGates("true")).toBe(false);
    expect(restoredGateLabelBackground(0.5)).toBe(0.5);
    expect(restoredGateLabelBackground(0)).toBe(0);
    expect(restoredGateLabelBackground(3)).toBe(1);
    expect(restoredGateLabelBackground(-1)).toBe(0);
    expect(restoredGateLineWidth(2.5)).toBe(2.5);
    expect(restoredGateLineWidth("3")).toBe(3);
    expect(restoredGateLineWidth(0.1)).toBe(0.4);
    expect(restoredGateLineWidth(40)).toBe(4);
  });

  it("inks copies of the gates, leaving the gates' own colours alone", () => {
    const gates = [{ gate_id: "g1", color: "#e41a1c" }, { gate_id: "g2", color: "#377eb8" }];
    expect(inkedForDisplay(gates, true, GATE_INK).map((g) => g.color)).toEqual(["#e41a1c", "#377eb8"]);
    expect(inkedForDisplay(gates, false, GATE_INK).map((g) => g.color)).toEqual(["#000000", "#000000"]);
    expect(gates.map((g) => g.color)).toEqual(["#e41a1c", "#377eb8"]);
    expect(displayGateColour("#e41a1c", true)).toBe("#e41a1c");
    expect(displayGateColour("#e41a1c", false)).toBe(GATE_INK);
  });
});

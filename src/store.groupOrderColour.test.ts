// Reordering groups and choosing a group's colour. Synthetic groups Treated, Control and B1 over
// synthetic files f1 to f3; nothing here is a real experiment.

import { describe, expect, it } from "vitest";
import { coreReducer, groupColour, initialCoreState, type CoreState } from "./store";
import { HIERARCHY_COLOURS } from "./engine/hierarchies";

function fixture(): CoreState {
  let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 10 });
  state = coreReducer(state, { type: "addGate", gateType: "rectangle", name: "Cells", xChannel: "FSC-A", yChannel: "SSC-A",
    vertices: [[0, 0], [100, 100]], createPop: { name: "Cells", parentId: state.active_population_id! } });
  state = coreReducer(state, { type: "addGroup", id: "g1", name: "Treated", fileIds: ["f1"] });
  state = coreReducer(state, { type: "addGroup", id: "g2", name: "Control", fileIds: ["f2"] });
  state = coreReducer(state, { type: "addGroup", id: "g3", name: "B1", fileIds: [] });
  return state;
}
const colours = (s: CoreState) => Object.fromEntries(s.groups.map((g, i) => [g.name, groupColour(s.groups, i)]));

describe("group order and colour", () => {
  it("takes the palette's colour by position until one is chosen", () => {
    const state = fixture();
    expect(colours(state)).toEqual({ Treated: HIERARCHY_COLOURS[0], Control: HIERARCHY_COLOURS[1], B1: HIERARCHY_COLOURS[2] });
  });

  it("reorders the groups as one undo entry, each keeping the colour it showed", () => {
    const state = fixture();
    const before = colours(state);
    const next = coreReducer(state, { type: "reorderGroups", ids: ["g3", "g1"] });
    expect(next.groups.map((g) => g.name)).toEqual(["B1", "Treated", "Control"]);
    expect(colours(next)).toEqual(before);
    expect(next.file_groups).toEqual(state.file_groups);
    expect(next.undo.length).toBe(state.undo.length + 1);
    expect(coreReducer(next, { type: "undo" }).groups.map((g) => g.name)).toEqual(["Treated", "Control", "B1"]);
    // The same order again is no change, and no undo entry.
    expect(coreReducer(next, { type: "reorderGroups", ids: ["g3", "g1", "g2"] })).toBe(next);
  });

  it("sets a group's colour, refusing anything but #rrggbb, and undoes it", () => {
    const state = fixture();
    const next = coreReducer(state, { type: "setGroupColour", id: "g2", colour: "#1F9E89" });
    expect(colours(next).Control).toBe("#1f9e89");
    expect(colours(next).Treated).toBe(HIERARCHY_COLOURS[0]);
    expect(coreReducer(next, { type: "setGroupColour", id: "g2", colour: "red" })).toBe(next);
    expect(coreReducer(next, { type: "setGroupColour", id: "g2", colour: "#1f9e89" })).toBe(next);
    expect(colours(coreReducer(next, { type: "undo" })).Control).toBe(HIERARCHY_COLOURS[1]);
  });
});

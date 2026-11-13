// A population made with an ellipse gate takes its own colour slot when it is created, as rectangle
// and polygon populations do, so its colour does not change when the workspace is reopened.

import { describe, expect, it } from "vitest";
import { coreReducer, initialCoreState } from "./store";

describe("an ellipse population's colour slot", () => {
  it("is assigned at creation and differs from the populations already drawn", () => {
    let state = coreReducer(initialCoreState(), { type: "loadSample", nEvents: 10 });
    const root = state.root_population_id!;
    state = coreReducer(state, { type: "addGate", gateType: "rectangle", name: "Cells", xChannel: "FSC-A", yChannel: "SSC-A",
      vertices: [[0, 0], [10, 0], [10, 10], [0, 10]], createPop: { name: "Cells", parentId: root } });
    state = coreReducer(state, { type: "addEllipse", name: "CD4_positive", xChannel: "FL1-A", yChannel: "FL2-A", mean: [1, 1], radii: [1, 1],
      createPop: { name: "CD4_positive", parentId: root } });
    const cells = Object.values(state.populations).find((p) => p.name === "Cells")!;
    const cd4 = Object.values(state.populations).find((p) => p.name === "CD4_positive")!;
    expect(typeof cd4.colorSlot).toBe("number");
    expect(cd4.colorSlot).not.toBe(cells.colorSlot);
  });
});
